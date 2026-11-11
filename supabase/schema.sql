-- ============================================================
-- EPICK CHAT database schema for Supabase
-- Run this whole file once in: Supabase Dashboard -> SQL Editor
-- It is safe to run again (idempotent-ish).
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- TABLES
-- ------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  display_name text,
  color text not null default '#0a7d32',
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));

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
  created_at timestamptz not null default now()
);

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
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);
create index if not exists dm_messages_thread_created_idx on public.dm_messages (thread_id, created_at desc);
create index if not exists room_members_user_idx on public.room_members (user_id);
create index if not exists friendships_addressee_idx on public.friendships (addressee);

-- ------------------------------------------------------------
-- SEED: the #lobby room everyone lands in
-- ------------------------------------------------------------

insert into public.rooms (id, name, topic, is_private, owner)
values ('00000000-0000-0000-0000-000000000001', 'lobby', 'Welcome to Epick Chat. Be excellent to each other.', false, null)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- NEW USER TRIGGER: create profile + join lobby
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
-- HELPER FUNCTIONS (security definer avoids RLS recursion)
-- ------------------------------------------------------------

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

-- Public username check for the registration form (works before sign-in).
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

-- ------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;
alter table public.dm_threads enable row level security;
alter table public.dm_messages enable row level security;

-- profiles: any signed-in user can look people up; you may edit yourself
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- friendships: you can see your own requests, send them, accept them, delete them
drop policy if exists "friendships_select_own" on public.friendships;
create policy "friendships_select_own" on public.friendships
  for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

drop policy if exists "friendships_insert_own" on public.friendships;
create policy "friendships_insert_own" on public.friendships
  for insert to authenticated
  with check (requester = auth.uid() and addressee <> auth.uid() and status = 'pending');

drop policy if exists "friendships_update_accept" on public.friendships;
-- Accepting a request goes through accept_friend_request() below, so there is
-- deliberately no direct UPDATE policy here. This prevents someone from
-- rewriting the requester/addressee columns of a pending request.

drop policy if exists "friendships_delete_own" on public.friendships;
create policy "friendships_delete_own" on public.friendships
  for delete to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

-- rooms: public rooms are visible to everyone, private rooms only to members/owner
drop policy if exists "rooms_select_visible" on public.rooms;
create policy "rooms_select_visible" on public.rooms
  for select to authenticated
  using (not is_private or owner = auth.uid() or public.is_room_member(id));

drop policy if exists "rooms_insert_own" on public.rooms;
create policy "rooms_insert_own" on public.rooms
  for insert to authenticated
  with check (owner = auth.uid());

drop policy if exists "rooms_update_own" on public.rooms;
create policy "rooms_update_own" on public.rooms
  for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists "rooms_delete_own" on public.rooms;
create policy "rooms_delete_own" on public.rooms
  for delete to authenticated using (owner = auth.uid());

-- room membership
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
    and exists (
      select 1 from public.rooms r
      where r.id = room_id and (not r.is_private or r.owner = auth.uid())
    )
  );

drop policy if exists "room_members_delete" on public.room_members;
create policy "room_members_delete" on public.room_members
  for delete to authenticated using (user_id = auth.uid());

-- room messages: readable in visible rooms, writable if you joined
drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages
  for select to authenticated using (public.can_read_room(room_id));

drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages
  for insert to authenticated
  with check (sender = auth.uid() and public.can_post_room(room_id));

-- direct messages
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
  );

drop policy if exists "dm_threads_delete" on public.dm_threads;
-- No client-side delete policy: DM history is not destroyed by one participant.

drop policy if exists "dm_messages_select" on public.dm_messages;
create policy "dm_messages_select" on public.dm_messages
  for select to authenticated using (public.in_dm_thread(thread_id));

drop policy if exists "dm_messages_insert" on public.dm_messages;
create policy "dm_messages_insert" on public.dm_messages
  for insert to authenticated
  with check (sender = auth.uid() and public.in_dm_thread(thread_id));

-- ------------------------------------------------------------
-- RPCs
-- ------------------------------------------------------------

create or replace function public.accept_friend_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;

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

-- ------------------------------------------------------------
-- REALTIME
-- ------------------------------------------------------------

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

-- ------------------------------------------------------------
-- DONE. New signups automatically get a profile and join #lobby.
-- ------------------------------------------------------------
