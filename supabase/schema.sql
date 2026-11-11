create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  display_name text,
  color text not null default '#0a7d32',
  bio text default '',
  avatar_url text,
  banner_url text,
  rank text not null default 'member',
  banned boolean not null default false,
  ban_reason text,
  banned_at timestamptz,
  banned_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));

alter table public.profiles add column if not exists bio text default '';
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists banner_url text;
alter table public.profiles add column if not exists rank text not null default 'member';
alter table public.profiles add column if not exists banned boolean not null default false;
alter table public.profiles add column if not exists ban_reason text;
alter table public.profiles add column if not exists banned_at timestamptz;
alter table public.profiles add column if not exists banned_by uuid references public.profiles(id) on delete set null;

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester uuid not null references public.profiles(id) on delete cascade,
  addressee uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index if not exists friendships_pair_idx
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 32),
  topic text default '',
  is_private boolean not null default false,
  invite_code text unique,
  owner uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender uuid references public.profiles(id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  reply_to bigint,
  reply_snippet text,
  created_at timestamptz not null default now()
);
alter table public.messages add column if not exists reply_to bigint;
alter table public.messages add column if not exists reply_snippet text;

create table if not exists public.dm_threads (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (user_a < user_b)
);
create unique index if not exists dm_threads_pair_idx on public.dm_threads (user_a, user_b);

create table if not exists public.dm_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null references public.dm_threads(id) on delete cascade,
  sender uuid references public.profiles(id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  reply_to bigint,
  reply_snippet text,
  created_at timestamptz not null default now()
);
alter table public.dm_messages add column if not exists reply_to bigint;
alter table public.dm_messages add column if not exists reply_snippet text;

create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);
create index if not exists dm_messages_thread_created_idx on public.dm_messages (thread_id, created_at desc);
create index if not exists room_members_user_idx on public.room_members (user_id);
create index if not exists friendships_addressee_idx on public.friendships (addressee);

insert into public.rooms (id, name, topic, is_private, owner)
values ('00000000-0000-0000-0000-000000000001', 'lobby', 'Welcome to Epick Chat. Be excellent to each other.', false, null)
on conflict (id) do nothing;

create or replace function public.pick_color()
returns text
language sql
volatile
as $$
  select (array['#0a7d32','#7a2fbf','#b8860b','#c0392b','#1f6feb','#a0522d','#008b8b','#d2691e'])
         [(1 + floor(random() * 8))::int];
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uname text;
  dname text;
begin
  uname := lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)));
  uname := regexp_replace(uname, '[^a-z0-9_]', '', 'g');
  if length(uname) < 3 then
    uname := 'user' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;
  uname := left(uname, 20);

  dname := coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), uname);

  insert into public.profiles (id, username, display_name, color)
  values (new.id, uname, dname, public.pick_color());

  insert into public.room_members (room_id, user_id)
  select id, new.id from public.rooms
  where id = '00000000-0000-0000-0000-000000000001'
  on conflict do nothing;

  return new;
exception
  when unique_violation then
    raise exception 'That username is already taken. Try another one.';
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_room_member(rid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.room_members
    where room_id = rid and user_id = auth.uid()
  );
$$;

create or replace function public.can_read_room(rid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = rid
      and (
        not r.is_private
        or exists (
          select 1 from public.room_members m
          where m.room_id = r.id and m.user_id = auth.uid()
        )
      )
  );
$$;

create or replace function public.can_post_room(rid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.room_members
    where room_id = rid and user_id = auth.uid()
  );
$$;

create or replace function public.are_friends(u1 uuid, u2 uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and (
        (f.requester = u1 and f.addressee = u2)
        or (f.requester = u2 and f.addressee = u1)
      )
  );
$$;

create or replace function public.in_dm_thread(tid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.dm_threads t
    where t.id = tid and (t.user_a = auth.uid() or t.user_b = auth.uid())
  );
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and rank in ('owner', 'co-owner', 'admin', 'mod') and not banned
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and rank in ('owner', 'co-owner', 'admin') and not banned
  );
$$;

create or replace function public.is_banned()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select banned from public.profiles where id = auth.uid()),
    false
  );
$$;

create or replace function public.username_available(p_username text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select not exists (
    select 1 from public.profiles
    where lower(username) = lower(trim(p_username))
  );
$$;

grant execute on function public.username_available(text) to anon, authenticated;

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;
alter table public.dm_threads enable row level security;
alter table public.dm_messages enable row level security;

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

revoke insert, update on public.profiles from authenticated;
grant insert (id, username, display_name, color) on public.profiles to authenticated;
grant update (display_name, bio, color, avatar_url, banner_url) on public.profiles to authenticated;

drop policy if exists "friendships_select_own" on public.friendships;
create policy "friendships_select_own" on public.friendships
  for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

drop policy if exists "friendships_insert_own" on public.friendships;
create policy "friendships_insert_own" on public.friendships
  for insert to authenticated
  with check (
    requester = auth.uid()
    and addressee <> auth.uid()
    and status = 'pending'
    and not public.is_banned()
  );

drop policy if exists "friendships_update_accept" on public.friendships;

drop policy if exists "friendships_delete_own" on public.friendships;
create policy "friendships_delete_own" on public.friendships
  for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

drop policy if exists "rooms_select_visible" on public.rooms;
create policy "rooms_select_visible" on public.rooms
  for select to authenticated
  using (not is_private or owner = auth.uid() or public.is_room_member(id));

drop policy if exists "rooms_insert_own" on public.rooms;
create policy "rooms_insert_own" on public.rooms
  for insert to authenticated
  with check (owner = auth.uid() and not public.is_banned());

drop policy if exists "rooms_update_own" on public.rooms;
create policy "rooms_update_own" on public.rooms
  for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists "rooms_delete_own" on public.rooms;
create policy "rooms_delete_own" on public.rooms
  for delete to authenticated using (owner = auth.uid());

drop policy if exists "room_members_select" on public.room_members;
create policy "room_members_select" on public.room_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_room_member(room_id)
    or exists (
      select 1 from public.rooms r
      where r.id = room_id and not r.is_private
    )
  );

drop policy if exists "room_members_insert" on public.room_members;
create policy "room_members_insert" on public.room_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and not public.is_banned()
    and exists (
      select 1 from public.rooms r
      where r.id = room_id and (not r.is_private or r.owner = auth.uid())
    )
  );

drop policy if exists "room_members_delete" on public.room_members;
create policy "room_members_delete" on public.room_members
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages
  for select to authenticated using (public.can_read_room(room_id));

drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages
  for insert to authenticated
  with check (
    sender = auth.uid()
    and not public.is_banned()
    and public.can_post_room(room_id)
  );

drop policy if exists "messages_delete" on public.messages;
create policy "messages_delete" on public.messages
  for delete to authenticated
  using (sender = auth.uid() or public.is_staff());

drop policy if exists "dm_threads_select" on public.dm_threads;
create policy "dm_threads_select" on public.dm_threads
  for select to authenticated
  using (user_a = auth.uid() or user_b = auth.uid());

drop policy if exists "dm_threads_insert" on public.dm_threads;
create policy "dm_threads_insert" on public.dm_threads
  for insert to authenticated
  with check (
    (user_a = auth.uid() or user_b = auth.uid())
    and public.are_friends(user_a, user_b)
    and not public.is_banned()
  );

drop policy if exists "dm_threads_delete" on public.dm_threads;

drop policy if exists "dm_messages_select" on public.dm_messages;
create policy "dm_messages_select" on public.dm_messages
  for select to authenticated using (public.in_dm_thread(thread_id));

drop policy if exists "dm_messages_insert" on public.dm_messages;
create policy "dm_messages_insert" on public.dm_messages
  for insert to authenticated
  with check (
    sender = auth.uid()
    and not public.is_banned()
    and public.in_dm_thread(thread_id)
  );

drop policy if exists "dm_messages_delete" on public.dm_messages;
create policy "dm_messages_delete" on public.dm_messages
  for delete to authenticated
  using (sender = auth.uid());

create or replace function public.accept_friend_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if public.is_banned() then raise exception 'You are banned'; end if;

  update public.friendships
  set status = 'accepted'
  where id = p_id
    and addressee = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Friend request not found';
  end if;
end;
$$;

grant execute on function public.accept_friend_request(uuid) to authenticated;

create or replace function public.create_room(p_name text, p_topic text default '', p_private boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  rid uuid;
  code text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if public.is_banned() then raise exception 'You are banned'; end if;

  p_name := trim(p_name);
  if p_name is null or length(p_name) = 0 then raise exception 'Room name is required'; end if;
  if length(p_name) > 32 then raise exception 'Room name is too long'; end if;

  if p_private then
    code := lower(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
  end if;

  insert into public.rooms (name, topic, is_private, invite_code, owner)
  values (p_name, coalesce(p_topic, ''), p_private, code, auth.uid())
  returning id into rid;

  insert into public.room_members (room_id, user_id) values (rid, auth.uid());
  return rid;
end;
$$;

create or replace function public.join_room_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  rid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if public.is_banned() then raise exception 'You are banned'; end if;

  select id into rid
  from public.rooms
  where invite_code = lower(trim(p_code)) and is_private;

  if rid is null then
    raise exception 'Invalid invite code';
  end if;

  insert into public.room_members (room_id, user_id)
  values (rid, auth.uid())
  on conflict do nothing;

  return rid;
end;
$$;

create or replace function public.get_or_create_dm(p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
  b uuid;
  tid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if public.is_banned() then raise exception 'You are banned'; end if;
  if p_other = auth.uid() then raise exception 'You cannot DM yourself'; end if;
  if not public.are_friends(auth.uid(), p_other) then raise exception 'You must be friends first'; end if;

  if auth.uid() < p_other then
    a := auth.uid(); b := p_other;
  else
    a := p_other; b := auth.uid();
  end if;

  select id into tid from public.dm_threads where user_a = a and user_b = b;
  if tid is null then
    insert into public.dm_threads (user_a, user_b) values (a, b) returning id into tid;
  end if;

  return tid;
end;
$$;

drop function if exists public.claim_owner();

create or replace function public.set_rank(p_user uuid, p_rank text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  my_rank text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

  select rank into my_rank from public.profiles where id = auth.uid() and not banned;
  if my_rank is null or my_rank not in ('owner', 'co-owner') then
    raise exception 'Only the owner or a co-owner can change ranks';
  end if;
  if p_rank is null or p_rank not in ('owner', 'co-owner', 'admin', 'mod', 'member') then
    raise exception 'Unknown rank';
  end if;
  if p_user = auth.uid() then
    raise exception 'You cannot change your own rank';
  end if;
  if my_rank = 'co-owner' and p_rank in ('owner', 'co-owner') then
    raise exception 'Co-owners cannot grant owner or co-owner';
  end if;

  update public.profiles set rank = p_rank where id = p_user;
end;
$$;
grant execute on function public.set_rank(uuid, text) to authenticated;

create or replace function public.ban_user(p_username text, p_reason text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.profiles%rowtype;
  my_rank text;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;

  select * into target from public.profiles
  where lower(username) = lower(trim(p_username));
  if not found then raise exception 'No such user'; end if;
  if target.id = auth.uid() then raise exception 'You cannot ban yourself'; end if;
  if target.rank in ('owner', 'co-owner') then
    raise exception 'You cannot ban an owner or co-owner';
  end if;

  select rank into my_rank from public.profiles where id = auth.uid();
  if target.rank = 'admin' and my_rank not in ('owner', 'co-owner') then
    raise exception 'Only the owner or co-owner can ban an admin';
  end if;

  update public.profiles
  set banned = true,
      ban_reason = left(coalesce(p_reason, ''), 200),
      banned_at = now(),
      banned_by = auth.uid()
  where id = target.id;
end;
$$;
grant execute on function public.ban_user(text, text) to authenticated;

create or replace function public.unban_user(p_username text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;

  update public.profiles
  set banned = false,
      ban_reason = null,
      banned_at = null,
      banned_by = null
  where lower(username) = lower(trim(p_username));

  if not found then raise exception 'No such user'; end if;
end;
$$;
grant execute on function public.unban_user(text) to authenticated;

create or replace function public.purge_room(p_room uuid, p_count integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  if not public.is_staff() then raise exception 'Staff only'; end if;
  if p_count is null or p_count < 1 or p_count > 100 then
    raise exception 'Purge count must be between 1 and 100';
  end if;

  with doomed as (
    select id from public.messages
    where room_id = p_room
    order by created_at desc
    limit p_count
  )
  delete from public.messages m
  using doomed d
  where m.id = d.id;

  get diagnostics removed = row_count;
  return removed;
end;
$$;
grant execute on function public.purge_room(uuid, integer) to authenticated;

create or replace function public.set_room_topic(p_room uuid, p_topic text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (
    public.is_staff()
    or (
      not public.is_banned()
      and exists (select 1 from public.rooms where id = p_room and owner = auth.uid())
    )
  ) then
    raise exception 'Not allowed';
  end if;

  update public.rooms
  set topic = left(coalesce(p_topic, ''), 200)
  where id = p_room;
end;
$$;
grant execute on function public.set_room_topic(uuid, text) to authenticated;

create or replace function public.announce(p_room uuid, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if p_text is null or length(trim(p_text)) = 0 then
    raise exception 'Announcement is empty';
  end if;

  insert into public.messages (room_id, sender, body)
  values (p_room, null, '[ANNOUNCEMENT] ' || left(trim(p_text), 500));
end;
$$;
grant execute on function public.announce(uuid, text) to authenticated;

create or replace function public.admin_delete_room(p_room uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  delete from public.rooms where id = p_room;
end;
$$;
grant execute on function public.admin_delete_room(uuid) to authenticated;

alter table public.messages replica identity full;
alter table public.dm_messages replica identity full;
alter table public.friendships replica identity full;
alter table public.rooms replica identity full;
alter table public.room_members replica identity full;
alter table public.profiles replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

do $$
begin
  begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.dm_messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.friendships; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.rooms; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.room_members; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
end;
$$;

insert into storage.buckets (id, name, public)
values ('epick', 'epick', true)
on conflict (id) do update set public = true;

drop policy if exists "epick bucket read" on storage.objects;
create policy "epick bucket read" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'epick');

drop policy if exists "epick bucket insert" on storage.objects;
create policy "epick bucket insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'epick'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

drop policy if exists "epick bucket update" on storage.objects;
create policy "epick bucket update" on storage.objects
  for update to authenticated
  using (bucket_id = 'epick' and (storage.foldername(name))[2] = auth.uid()::text)
  with check (bucket_id = 'epick' and (storage.foldername(name))[2] = auth.uid()::text);

drop policy if exists "epick bucket delete" on storage.objects;
create policy "epick bucket delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'epick' and (storage.foldername(name))[2] = auth.uid()::text);

alter table public.rooms add column if not exists icon_url text;
alter table public.rooms add column if not exists accent text not null default '#000080';
alter table public.rooms add column if not exists font text not null default 'default';
alter table public.rooms add column if not exists post_mode text not null default 'open';
alter table public.rooms add column if not exists slowmode integer not null default 0;
alter table public.rooms add column if not exists welcome text not null default '';
alter table public.rooms add column if not exists updated_at timestamptz not null default now();

alter table public.room_members add column if not exists muted boolean not null default false;
alter table public.room_members add column if not exists room_role text not null default 'member';

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null,
  body text not null,
  room_id uuid references public.rooms(id) on delete cascade,
  actor uuid references public.profiles(id) on delete set null,
  seen boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

create table if not exists public.mod_calls (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  body text not null,
  status text not null default 'open',
  claimed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null
);
create index if not exists mod_calls_open_idx on public.mod_calls (status, created_at desc);

create or replace function public.is_room_owner(rid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.rooms where id = rid and owner = auth.uid()
  );
$$;

create or replace function public.room_role_of(rid uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select 'owner' from public.rooms where id = rid and owner = auth.uid()),
    (select room_role from public.room_members where room_id = rid and user_id = auth.uid()),
    'none'
  );
$$;

create or replace function public.can_moderate_room(rid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_staff() or public.room_role_of(rid) in ('owner', 'mod');
$$;

create or replace function public.can_post_room(rid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.rooms r
    join public.room_members m on m.room_id = r.id and m.user_id = auth.uid()
    where r.id = rid
      and not public.is_banned()
      and (
        public.is_staff()
        or r.owner = auth.uid()
        or (
          not m.muted
          and (
            r.post_mode = 'open'
            or (r.post_mode = 'mods' and m.room_role = 'mod')
          )
        )
      )
      and (
        r.slowmode <= 0
        or public.is_staff()
        or r.owner = auth.uid()
        or not exists (
          select 1 from public.messages mm
          where mm.room_id = r.id
            and mm.sender = auth.uid()
            and mm.created_at > now() - make_interval(secs => r.slowmode)
        )
      )
  );
$$;

create or replace function public.set_room_topic(p_room uuid, p_topic text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_moderate_room(p_room) then
    raise exception 'Room mods only';
  end if;

  update public.rooms
  set topic = left(coalesce(p_topic, ''), 200),
      updated_at = now()
  where id = p_room;
end;
$$;

create or replace function public.notify_mentions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.sender is null then
    return new;
  end if;

  insert into public.notifications (user_id, kind, body, room_id, actor)
  select p.id, 'mention', left(new.body, 180), new.room_id, new.sender
  from public.profiles p
  join public.room_members rm on rm.user_id = p.id and rm.room_id = new.room_id
  where p.id <> new.sender
    and not p.banned
    and new.body ~* ('(^|[^a-z0-9_])@' || p.username || '([^a-z0-9_]|$)');

  return new;
end;
$$;

drop trigger if exists messages_notify_mentions on public.messages;
create trigger messages_notify_mentions
  after insert on public.messages
  for each row execute function public.notify_mentions();

create or replace function public.notify_dm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  other uuid;
begin
  if new.sender is null then
    return new;
  end if;

  select case when t.user_a = new.sender then t.user_b else t.user_a end
  into other
  from public.dm_threads t
  where t.id = new.thread_id;

  if other is not null and other <> new.sender then
    insert into public.notifications (user_id, kind, body, actor)
    values (other, 'dm', left(new.body, 180), new.sender);
  end if;

  return new;
end;
$$;

drop trigger if exists dm_messages_notify on public.dm_messages;
create trigger dm_messages_notify
  after insert on public.dm_messages
  for each row execute function public.notify_dm();

create or replace function public.room_update_settings(
  p_room uuid,
  p_name text,
  p_topic text,
  p_icon text,
  p_accent text,
  p_font text,
  p_post_mode text,
  p_slowmode integer,
  p_welcome text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cur public.rooms%rowtype;
  clean_name text;
  clean_topic text;
  clean_welcome text;
  clean_accent text;
  clean_font text;
  clean_mode text;
  clean_slow integer;
  changes text[] := array[]::text[];
begin
  if not (public.is_staff() or public.is_room_owner(p_room)) then
    raise exception 'Room owner only';
  end if;

  select * into cur from public.rooms where id = p_room;
  if not found then
    raise exception 'Room not found';
  end if;

  clean_name := left(trim(coalesce(p_name, '')), 32);
  if length(clean_name) = 0 then
    raise exception 'Room name is required';
  end if;

  clean_topic := left(coalesce(p_topic, ''), 200);
  clean_welcome := left(coalesce(p_welcome, ''), 200);
  clean_accent := coalesce(p_accent, '#000080');
  if clean_accent !~* '^#[0-9a-f]{6}$' then
    clean_accent := '#000080';
  end if;

  clean_font := coalesce(p_font, 'default');
  if clean_font not in ('default', 'mono', 'serif', 'comic', 'typewriter') then
    clean_font := 'default';
  end if;

  clean_mode := coalesce(p_post_mode, 'open');
  if clean_mode not in ('open', 'mods', 'owner') then
    clean_mode := 'open';
  end if;

  clean_slow := greatest(0, least(300, coalesce(p_slowmode, 0)));

  if cur.name <> clean_name then changes := array_append(changes, 'name'); end if;
  if coalesce(cur.topic, '') <> clean_topic then changes := array_append(changes, 'topic'); end if;
  if coalesce(cur.icon_url, '') <> coalesce(p_icon, '') then changes := array_append(changes, 'photo'); end if;
  if cur.accent <> clean_accent then changes := array_append(changes, 'colour'); end if;
  if cur.font <> clean_font then changes := array_append(changes, 'font'); end if;
  if cur.post_mode <> clean_mode then changes := array_append(changes, 'who can talk'); end if;
  if cur.slowmode <> clean_slow then changes := array_append(changes, 'slowmode'); end if;
  if coalesce(cur.welcome, '') <> clean_welcome then changes := array_append(changes, 'welcome'); end if;

  update public.rooms
  set name = clean_name,
      topic = clean_topic,
      icon_url = nullif(p_icon, ''),
      accent = clean_accent,
      font = clean_font,
      post_mode = clean_mode,
      slowmode = clean_slow,
      welcome = clean_welcome,
      updated_at = now()
  where id = p_room;

  if array_length(changes, 1) > 0 then
    insert into public.notifications (user_id, kind, body, room_id, actor)
    select rm.user_id, 'room',
      '#' || clean_name || ' changed: ' || array_to_string(changes, ', '),
      p_room, auth.uid()
    from public.room_members rm
    where rm.room_id = p_room and rm.user_id <> auth.uid();
  end if;
end;
$$;
grant execute on function public.room_update_settings(uuid, text, text, text, text, text, text, integer, text) to authenticated;

create or replace function public.room_kick(p_room uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  room_owner uuid;
  room_name text;
  target_rank text;
begin
  if not public.can_moderate_room(p_room) then
    raise exception 'Room mods only';
  end if;
  if p_user = auth.uid() then
    raise exception 'Use leave room instead';
  end if;

  select owner, name into room_owner, room_name from public.rooms where id = p_room;
  if p_user = room_owner then
    raise exception 'You cannot kick the room owner';
  end if;

  select rank into target_rank from public.profiles where id = p_user;
  if target_rank is null then
    raise exception 'No such member';
  end if;
  if target_rank in ('owner', 'co-owner', 'admin', 'mod') and not public.is_staff() then
    raise exception 'You cannot kick staff';
  end if;

  delete from public.room_members where room_id = p_room and user_id = p_user;
  if not found then
    raise exception 'They are not in this room';
  end if;

  insert into public.notifications (user_id, kind, body, room_id, actor)
  values (p_user, 'kick', 'You were removed from #' || room_name, p_room, auth.uid());
end;
$$;
grant execute on function public.room_kick(uuid, uuid) to authenticated;

create or replace function public.room_set_muted(p_room uuid, p_user uuid, p_muted boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  room_owner uuid;
  room_name text;
  target_rank text;
begin
  if not public.can_moderate_room(p_room) then
    raise exception 'Room mods only';
  end if;

  select owner, name into room_owner, room_name from public.rooms where id = p_room;
  if p_user = room_owner then
    raise exception 'You cannot mute the room owner';
  end if;

  select rank into target_rank from public.profiles where id = p_user;
  if target_rank in ('owner', 'co-owner', 'admin', 'mod') and not public.is_staff() then
    raise exception 'You cannot mute staff';
  end if;

  update public.room_members set muted = coalesce(p_muted, false)
  where room_id = p_room and user_id = p_user;

  if not found then
    raise exception 'They are not in this room';
  end if;

  insert into public.notifications (user_id, kind, body, room_id, actor)
  values (
    p_user,
    'mute',
    case when coalesce(p_muted, false)
      then 'You were muted in #' || room_name
      else 'You can talk again in #' || room_name
    end,
    p_room,
    auth.uid()
  );
end;
$$;
grant execute on function public.room_set_muted(uuid, uuid, boolean) to authenticated;

create or replace function public.room_set_role(p_room uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  room_owner uuid;
  room_name text;
begin
  if not (public.is_staff() or public.is_room_owner(p_room)) then
    raise exception 'Room owner only';
  end if;
  if p_role not in ('member', 'mod') then
    raise exception 'Unknown room role';
  end if;

  select owner, name into room_owner, room_name from public.rooms where id = p_room;
  if p_user = room_owner then
    raise exception 'The owner already runs this room';
  end if;

  update public.room_members set room_role = p_role
  where room_id = p_room and user_id = p_user;

  if not found then
    raise exception 'They are not in this room';
  end if;

  insert into public.notifications (user_id, kind, body, room_id, actor)
  values (
    p_user,
    'role',
    case when p_role = 'mod'
      then 'You are now a room mod in #' || room_name
      else 'You are no longer a room mod in #' || room_name
    end,
    p_room,
    auth.uid()
  );
end;
$$;
grant execute on function public.room_set_role(uuid, uuid, text) to authenticated;

create or replace function public.room_invite(p_room uuid, p_username text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
  room_name text;
begin
  if not public.can_moderate_room(p_room) then
    raise exception 'Room mods only';
  end if;

  select id into target from public.profiles
  where lower(username) = lower(trim(p_username)) and not banned;
  if target is null then
    raise exception 'No such user';
  end if;

  select name into room_name from public.rooms where id = p_room;

  insert into public.room_members (room_id, user_id)
  values (p_room, target)
  on conflict do nothing;

  if found then
    insert into public.notifications (user_id, kind, body, room_id, actor)
    values (target, 'invite', 'You were added to #' || room_name, p_room, auth.uid());
  end if;
end;
$$;
grant execute on function public.room_invite(uuid, text) to authenticated;

create or replace function public.room_set_slowmode(p_room uuid, p_seconds integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_moderate_room(p_room) then
    raise exception 'Room mods only';
  end if;

  update public.rooms
  set slowmode = greatest(0, least(300, coalesce(p_seconds, 0))),
      updated_at = now()
  where id = p_room;
end;
$$;
grant execute on function public.room_set_slowmode(uuid, integer) to authenticated;

create or replace function public.room_set_post_mode(p_room uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  room_name text;
begin
  if not (public.is_staff() or public.is_room_owner(p_room)) then
    raise exception 'Room owner only';
  end if;
  if p_mode not in ('open', 'mods', 'owner') then
    raise exception 'Unknown room mode';
  end if;

  select name into room_name from public.rooms where id = p_room;

  update public.rooms
  set post_mode = p_mode,
      updated_at = now()
  where id = p_room;

  insert into public.notifications (user_id, kind, body, room_id, actor)
  select rm.user_id, 'room',
    '#' || room_name || ' now lets ' ||
      case p_mode
        when 'open' then 'everyone talk'
        when 'mods' then 'room mods talk'
        else 'only the owner talk'
      end,
    p_room, auth.uid()
  from public.room_members rm
  where rm.room_id = p_room and rm.user_id <> auth.uid();
end;
$$;
grant execute on function public.room_set_post_mode(uuid, text) to authenticated;

create or replace function public.send_modcall(p_room uuid, p_body text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  rid bigint;
  room_name text;
  recent integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if public.is_banned() then
    raise exception 'You are banned';
  end if;
  if not public.can_read_room(p_room) then
    raise exception 'You cannot see this room';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'Say what you need';
  end if;

  select count(*) into recent from public.mod_calls
  where user_id = auth.uid()
    and status = 'open'
    and created_at > now() - interval '10 minutes';
  if recent >= 3 then
    raise exception 'You already have open modcalls';
  end if;

  select name into room_name from public.rooms where id = p_room;

  insert into public.mod_calls (room_id, user_id, body)
  values (p_room, auth.uid(), left(trim(p_body), 300))
  returning id into rid;

  insert into public.notifications (user_id, kind, body, room_id, actor)
  select p.id, 'modcall',
    'modcall in #' || room_name || ': ' || left(trim(p_body), 120),
    p_room, auth.uid()
  from public.profiles p
  where p.rank in ('owner', 'co-owner', 'admin', 'mod')
    and not p.banned
    and p.id <> auth.uid();

  return rid;
end;
$$;
grant execute on function public.send_modcall(uuid, text) to authenticated;

create or replace function public.resolve_modcall(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.mod_calls%rowtype;
  room_name text;
begin
  if not public.is_staff() then
    raise exception 'Staff only';
  end if;

  select * into rec from public.mod_calls where id = p_id;
  if not found then
    raise exception 'No such modcall';
  end if;
  if rec.status <> 'open' then
    raise exception 'That call is already closed';
  end if;

  update public.mod_calls
  set status = 'resolved',
      claimed_by = coalesce(claimed_by, auth.uid()),
      resolved_at = now(),
      resolved_by = auth.uid()
  where id = p_id;

  select name into room_name from public.rooms where id = rec.room_id;

  if rec.user_id is not null then
    insert into public.notifications (user_id, kind, body, room_id, actor)
    values (
      rec.user_id,
      'modcall-done',
      'A mod answered your call in #' || coalesce(room_name, 'room'),
      rec.room_id,
      auth.uid()
    );
  end if;
end;
$$;
grant execute on function public.resolve_modcall(bigint) to authenticated;

alter table public.notifications enable row level security;
alter table public.mod_calls enable row level security;

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "notifications_delete_own" on public.notifications;
create policy "notifications_delete_own" on public.notifications
  for delete to authenticated using (user_id = auth.uid());

grant select on public.notifications to authenticated;
grant update (seen) on public.notifications to authenticated;
grant delete on public.notifications to authenticated;

drop policy if exists "mod_calls_select" on public.mod_calls;
create policy "mod_calls_select" on public.mod_calls
  for select to authenticated
  using (user_id = auth.uid() or public.is_staff());

grant select on public.mod_calls to authenticated;

alter table public.notifications replica identity full;
alter table public.mod_calls replica identity full;

do $$
begin
  begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.mod_calls; exception when duplicate_object then null; end;
end;
$$;

alter table public.profiles add column if not exists grad_from text;
alter table public.profiles add column if not exists grad_to text;
grant update (grad_from, grad_to) on public.profiles to authenticated;

create or replace function public.global_announce(p_text text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer;
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;
  if p_text is null or length(trim(p_text)) = 0 then
    raise exception 'Announcement is empty';
  end if;

  insert into public.messages (room_id, sender, body)
  select r.id, null, '[ANNOUNCEMENT] ' || left(trim(p_text), 500)
  from public.rooms r;

  get diagnostics total = row_count;
  return total;
end;
$$;
grant execute on function public.global_announce(text) to authenticated;

create or replace function public.global_lock(p_locked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  update public.rooms
  set post_mode = case when coalesce(p_locked, false) then 'owner' else 'open' end,
      updated_at = now();
end;
$$;
grant execute on function public.global_lock(boolean) to authenticated;

create or replace function public.global_slowmode(p_seconds integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only';
  end if;

  update public.rooms
  set slowmode = greatest(0, least(300, coalesce(p_seconds, 0))),
      updated_at = now();
end;
$$;
grant execute on function public.global_slowmode(integer) to authenticated;
