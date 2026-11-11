# Epick Chat

An old-school chat site: silver panels, navy title bars, sunken inputs, Verdana and Courier text, and underlined blue links. Under the hood it is plain HTML/CSS/JS with Supabase for accounts, storage, and realtime.

The design copies the everyday look of late-90s web chat rather than a modern "retro" theme: system colours, 1px gray borders, beveled buttons, and dense small text.

## What it does

- Username/password accounts; no email address is asked for or shown anywhere
- Custom profiles: display name, bio, avatar colour, avatar image, and banner
- Friends: search users, send requests, accept/decline, remove friends
- Direct messages between friends
- Public rooms anyone can join
- Private rooms with an invite code
- Room owner tools: rename, topic, welcome line, room photo, accent colour, chat font, slowmode, who-can-talk mode, room mods, mute, and kick
- Modcalls: anyone can call a mod into a room, staff see the open queue in the admin panel
- Notification bell: mentions, new DMs, room changes, kicks/mutes, and a "while you were away" summary
- Live messages, replies, and online dots via Supabase Realtime
- Message deletion (your own messages; staff can delete anyone's in rooms)
- Ranks shown next to names: `(owner)`, `(co-owner)`, `(admin)`, `(mod)`
- Admin panel for staff: change ranks, ban/unban, announce, delete rooms, fun buttons
- Bans: admins can stop a user from chatting, with a reason shown to that user
- Announcements only render as system notices when the database marks them as system; typing `[ANNOUNCEMENT]` does nothing special
- Chat commands such as `/me`, `/roll`, `/purge`, `/topic`, `/ban`, `/unban`, `/announce`, `/modcall`
- Chat image embeds show a content warning and a **view anyway** button first
- Chat history stored in Postgres, so Render redeploys do not wipe it
- Row Level Security: users can only read rooms/DMs they belong to

## Ranks

Ranks live on `public.profiles.rank` and are shown next to usernames.

| Rank | Colour | Can do |
| --- | --- | --- |
| `owner` | red | everything, including granting any rank |
| `co-owner` | purple | change ranks (except owner/co-owner), all admin actions |
| `admin` | blue | announce, delete rooms, delete any room message, ban/unban members and mods |
| `mod` | green | delete any room message, `/purge`, `/topic` |
| `member` | (none) | normal chat, delete own messages |

Ownership is not claimable from the site. To make the first owner, sign up normally, then run this once in the Supabase SQL Editor:

```sql
update public.profiles set rank = 'owner' where username = 'your_username';
```

After that, the owner and co-owners can change ranks in the admin panel. Bans follow the same hierarchy: admins can ban members and mods, only the owner or co-owner can ban another admin, and nobody can ban an owner, co-owner, or themselves.

## Chat commands

| Command | Who | What it does |
| --- | --- | --- |
| `/me waves` | everyone | emote line |
| `/shrug`, `/tableflip`, `/unflip` | everyone | fun text |
| `/roll 2d6`, `/coinflip`, `/8ball question` | everyone | dice, coin, magic 8-ball |
| `/help` | everyone | list commands |
| `/topic new topic` | room owner, room mod, staff | change the room topic |
| `/purge 10` | staff | delete the last N messages in the room |
| `/announce text` | admins | post a system announcement |
| `/ban username reason` | admins | stop a user from chatting |
| `/unban username` | admins | let a banned user chat again |
| `/kick username` | room owner, room mod, staff | remove someone from the room |
| `/mute username`, `/unmute username` | room owner, room mod, staff | stop or allow talking in the room |
| `/roommod username`, `/roomunmod username` | room owner, staff | give or remove the room-mod role |
| `/invite username` | room owner, room mod, staff | add someone to the room |
| `/slowmode 10` | room owner, room mod, staff | seconds between messages, 0 = off |
| `/lock`, `/unlock` | room owner, staff | owner-only talk / back to everyone |
| `/modcall reason` | everyone | send a call to all staff |
| `/report username reason` | everyone | report a user to the mods |
| `/resolve id` | staff | close an open modcall |
| `/users`, `/whois username`, `/stats` | everyone | room and user info |
| `/color #ff0000` | everyone | change your name colour |
| `/clear` | everyone | clear your local message view |

## Room owner tools

Open a room and press **settings** (room owner or staff only). The room settings box lets you change:

- name, topic, and a welcome line shown at the top of the room
- room photo (shown in the room list and header)
- accent colour and chat font (courier, serif, comic sans, typewriter)
- who can talk: everyone, room mods only, or owner only
- slowmode in seconds
- members: mute, promote to room mod, or kick

Room mods can use `/kick`, `/mute`, `/unmute`, `/invite`, and `/slowmode`, but cannot rename the room or change who can talk. A kick removes the person right away; public rooms auto-join when opened, so a kicked user can walk back into a public room. The notification bell shows mentions (`@username`), new DMs, room setting changes, kicks, mutes, and a summary of what happened while you were offline.

## Is it private?

The code is set up so that user data is private even though the site is publicly reachable:

- Passwords are handled by Supabase Auth. This app never stores or sees them.
- Row Level Security (RLS) is enabled on every table. A user can only read:
  - their own friend requests,
  - rooms they are a member of,
  - DMs they are part of,
  - public room messages.
- Private rooms are invisible to non-members and require an invite code to join.
- A user can only post as themselves, and only in rooms they joined.
- Friend requests must be accepted through a server-side function; a user cannot forge an accepted friendship.
- Image uploads go to the public `epick` bucket, but a user can only write inside their own `avatars/<uid>/`, `banners/<uid>/`, `chat/<uid>/`, and `rooms/<uid>/` folders.
- Rank changes, bans, announcements, room deletion, purges, room settings, room moderation, and modcalls run through server-side functions that check the caller's rank or room role.
- The `service_role` key is never used in the frontend.

### About the Supabase key

The Supabase **anon** key is a public browser key by design. It is not a password, and it is safe to expose *as long as RLS is enabled* (it is, in `supabase/schema.sql`). The deployed JavaScript will always contain whatever key the browser uses; that is how Supabase client apps work.

What this repo does:

- `js/config.js` is **gitignored**, so your key does not go into the public GitHub repo.
- On Render, `build-config.js` generates `js/config.js` at build time from Render environment variables.
- Never put the `service_role` key in the frontend. That key bypasses RLS.

If you want the whole site locked down (no public signups), turn off new signups in Supabase **Authentication -> Providers -> Email** or remove the signup form.

### Username-only accounts

Supabase Auth is built around an email address, so the app quietly turns a username into an internal address (`username@epick.local`). That address never appears in the UI, is never shown to other users, and is not used to send mail. The only thing users type is a username and password.

Because of that, **Confirm email must be off**. If it is on, Supabase waits for a confirmation that can never arrive, and username-only signups cannot sign in.

## Files

```
EpickChat/
  index.html              the whole UI (login + chat + modals)
  styles.css              old-web stylesheet
  banners/                preset banner images (2300x1080)
  js/config.example.js    copy to js/config.js for local development
  js/config.js            generated / gitignored (your local values)
  js/app.js               auth, rooms, friends, DMs, profiles, ranks, realtime
  js/banners.js           banner preset manifest (add every image here)
  build-config.js         writes js/config.js from env vars on Render
  supabase/schema.sql     run this once in Supabase
  render.yaml             Render static-site blueprint
  .gitignore
  favicon.svg
  README.md
```

## 1. Set up the database (5 minutes)

1. Make a free account at <https://supabase.com> and create a new project.
2. Open **SQL Editor**, paste the entire contents of `supabase/schema.sql`, and click **Run**.
   - This creates the tables, policies, storage bucket, ranks, bans, room tools, modcalls, notifications, admin functions, realtime setup, the `#lobby` room, and a trigger that gives every new user a profile.
   - `schema.sql` is safe to re-run on an existing project: it adds the newer columns and policies without deleting your data.
3. Open **Project Settings -> API** and copy:
   - **Project URL**
   - **anon public** key (not the service_role key)

### Email confirmation

The app never asks for an email, so there is nothing to confirm. Go to **Authentication -> Providers -> Email** and turn **Confirm email** off. With it on, new accounts are created but cannot sign in until an email that does not exist is confirmed.

## 2. Run it locally

Copy the example config and fill in your values:

```bash
copy js\config.example.js js\config.js
```

Then edit `js/config.js`:

```js
window.EPICK_CONFIG = {
  SUPABASE_URL: "https://abcdefghijk.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi..."
};
```

Serve the folder (do not open it as a `file://` URL; Supabase auth needs a real origin):

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

You can also generate the config from environment variables:

```powershell
$env:SUPABASE_URL="https://abcdefghijk.supabase.co"
$env:SUPABASE_ANON_KEY="eyJhbGciOi..."
node build-config.js
```

## 3. Deploy to Render

This is a static site, so no server is needed.

1. Push this folder to a GitHub repository.
2. In Render, choose **New + -> Blueprint** and select the repo.
3. Render reads `render.yaml` and asks for two environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
4. Paste the values from Supabase. They are stored in Render, not in the repo.
5. Deploy. The build command runs `node build-config.js`, which writes the key into `js/config.js` for that build only.
6. After the first deploy, set Supabase **Authentication -> URL Configuration -> Site URL** to the `onrender.com` URL. You do not need redirect URLs for username-only signups, but adding the site URL is still good practice.

Manual route instead of the Blueprint: **New + -> Static Site**, connect the repo, set the build command to `node build-config.js`, and set **Publish directory** to `.`. Add the two environment variables in the dashboard.

## Notes

- Supabase free projects pause after a period of inactivity. They resume when opened; data is not lost.
- Realtime is enabled by `schema.sql`. If messages only appear after a refresh, check **Database -> Replication** and make sure the `messages`, `dm_messages`, `friendships`, `rooms`, `room_members`, and `profiles` tables are in the `supabase_realtime` publication.
- **Upgrading an existing install:** re-run the whole `supabase/schema.sql` in the SQL Editor. It adds `bio`, `avatar_url`, `banner_url`, `rank`, `reply_to`, `reply_snippet`, the ban columns (`banned`, `ban_reason`, `banned_at`, `banned_by`), the `epick` storage bucket and its policies, and the admin RPCs. Without it, profiles, images, ranks, replies, bans, and admin actions will fail with a "column/schema cache" error.
- If image uploads fail, confirm the `epick` bucket exists and is public, then re-run the storage section of `schema.sql`.
- The old-web look is deliberate: silver system colours, navy gradient title bars, sunken inputs, beveled buttons, Verdana/Courier type, and tiny underlined links.

### Adding banners

Static hosting cannot list a folder at runtime, so the picker only shows images named in `js/banners.js`. Drop a PNG or JPG into `banners/`, then add one line:

```js
{ id: 'my-banner', name: 'My Banner', file: 'banners/my-banner.png' }
```

Reload the page and it appears in the profile editor. The three included PNGs (`bliss.png`, `nyancat.png`, `pipes.png`) are already listed.

## Troubleshooting

**"SETUP REQUIRED" will not go away**
`js/config.js` is missing or still has the placeholder URL/key, or the file was cached. On Render, changing environment variables requires **Manual Deploy -> Clear build cache & deploy**. Then hard-refresh.

**Profile save says columns are missing**
Re-run `supabase/schema.sql`; the newer `profiles` columns have not been added to that project yet.

**Image upload says storage is not ready**
Re-run the storage section of `supabase/schema.sql` so the public `epick` bucket and its folder policies exist.

**Rank options do nothing**
Only the owner and co-owners can change ranks, and you cannot change your own. There is no claim button: set the first owner manually with `update public.profiles set rank = 'owner' where username = 'your_username';` in the Supabase SQL Editor.

**A user still cannot sign in after registering**
Turn off **Confirm email** in Supabase under **Authentication -> Providers -> Email**. Username-only accounts use internal addresses, so confirmation mail can never be completed.

**"Database error saving new user"**
The username is probably taken. Re-run the latest `schema.sql` so the `username_available` function exists, then try a different username.

**No messages show up**
Run the realtime section of `schema.sql` again, then hard-refresh. Also confirm the sender is a member of the room (public rooms auto-join when you click them).

**Login works but the chat screen is empty**
Open the browser console. Usually this means `schema.sql` was not run against the same Supabase project that is in `js/config.js`.

**Private room invite code**
The code is shown in the room header after you create the room. Friends enter it with **join by invite code** in the left column.
