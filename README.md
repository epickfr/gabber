# Epick Chat

An intentionally old-looking chat site: beveled panels, navy title bars, Verdana and Courier text, and underlined blue links. Under the crust it is plain HTML/CSS/JS with Supabase for accounts, storage, and realtime.

The old look is a style choice, not a claim about the code's age.

## What it does

- Email/password accounts with a unique username
- Custom profiles: display name, bio, avatar colour, avatar image, and banner
- Friends: search users, send requests, accept/decline, remove friends
- Direct messages between friends
- Public rooms anyone can join
- Private rooms with an invite code
- Live messages, replies, and online dots via Supabase Realtime
- Message deletion (your own messages; staff can delete anyone's in rooms)
- Ranks shown next to names: `(owner)`, `(co-owner)`, `(admin)`, `(mod)`
- Admin panel for staff: change ranks, announce, delete rooms, fun buttons
- Chat commands such as `/me`, `/roll`, `/purge`, `/topic`, `/announce`
- Chat image embeds show a content warning and a **view anyway** button first
- Chat history stored in Postgres, so Render redeploys do not wipe it
- Row Level Security: users can only read rooms/DMs they belong to

## Ranks

Ranks live on `public.profiles.rank` and are shown next to usernames.

| Rank | Colour | Can do |
| --- | --- | --- |
| `owner` | red | everything, including granting any rank |
| `co-owner` | purple | change ranks (except owner/co-owner), all admin actions |
| `admin` | blue | announce, delete rooms, delete any room message |
| `mod` | green | delete any room message, `/purge`, `/topic` |
| `member` | (none) | normal chat, delete own messages |

The first person to press **claim ownership** (shown on the profile card when no owner exists) becomes the owner. After that, the owner and co-owners can change ranks in the admin panel.

## Chat commands

| Command | Who | What it does |
| --- | --- | --- |
| `/me waves` | everyone | emote line |
| `/shrug`, `/tableflip`, `/unflip` | everyone | fun text |
| `/roll 2d6`, `/coinflip`, `/8ball question` | everyone | dice, coin, magic 8-ball |
| `/help` | everyone | list commands |
| `/topic new topic` | staff or room owner | change the room topic |
| `/purge 10` | staff | delete the last N messages in the room |
| `/announce text` | admins | post a system announcement |

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
- Image uploads go to the public `epick` bucket, but a user can only write inside their own `avatars/<uid>/`, `banners/<uid>/`, and `chat/<uid>/` folders.
- Rank changes, announcements, room deletion, and purges run through server-side functions that check the caller's rank.
- The `service_role` key is never used in the frontend.

### About the Supabase key

The Supabase **anon** key is a public browser key by design. It is not a password, and it is safe to expose *as long as RLS is enabled* (it is, in `supabase/schema.sql`). The deployed JavaScript will always contain whatever key the browser uses; that is how Supabase client apps work.

What this repo does:

- `js/config.js` is **gitignored**, so your key does not go into the public GitHub repo.
- On Render, `build-config.js` generates `js/config.js` at build time from Render environment variables.
- Never put the `service_role` key in the frontend. That key bypasses RLS.

If you want the whole site locked down (no public signups), turn off new signups in Supabase **Authentication -> Providers -> Email** or remove the signup form.

## Files

```
EpickChat/
  index.html              the whole UI (login + chat + modals)
  styles.css              retro stylesheet
  banners/                preset banner images (2300x1080)
  js/config.example.js    copy to js/config.js for local development
  js/config.js            generated / gitignored (your local values)
  js/app.js               auth, rooms, friends, DMs, profiles, ranks, realtime
  js/banners.js           banner preset manifest
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
   - This creates the tables, policies, storage bucket, ranks, admin functions, realtime setup, the `#lobby` room, and a trigger that gives every new user a profile.
   - `schema.sql` is safe to re-run on an existing project: it adds the newer columns and policies without deleting your data.
3. Open **Project Settings -> API** and copy:
   - **Project URL**
   - **anon public** key (not the service_role key)

### Email confirmation

By default Supabase asks new users to confirm their email. You can either:

- **Simplest:** go to **Authentication -> Providers -> Email** and turn **Confirm email** off. Signup then logs you straight in.
- **Keep it on:** go to **Authentication -> URL Configuration** and set the **Site URL** to your Render URL (and add it to **Redirect URLs**). New users will get a confirmation email.

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
6. After the first deploy, copy the `onrender.com` URL into Supabase **Authentication -> URL Configuration -> Site URL** (and Redirect URLs if you kept email confirmation on).

Manual route instead of the Blueprint: **New + -> Static Site**, connect the repo, set the build command to `node build-config.js`, and set **Publish directory** to `.`. Add the two environment variables in the dashboard.

## Notes

- Supabase free projects pause after a period of inactivity. They resume when opened; data is not lost.
- Realtime is enabled by `schema.sql`. If messages only appear after a refresh, check **Database -> Replication** and make sure the `messages`, `dm_messages`, `friendships`, `rooms`, `room_members`, and `profiles` tables are in the `supabase_realtime` publication.
- **Upgrading an existing install:** re-run the whole `supabase/schema.sql` in the SQL Editor. It adds `bio`, `avatar_url`, `banner_url`, `rank`, `reply_to`, `reply_snippet`, the `epick` storage bucket and its policies, and the admin RPCs. Without it, profiles, images, ranks, replies, and admin actions will fail with a "column/schema cache" error.
- If image uploads fail, confirm the `epick` bucket exists and is public, then re-run the storage section of `schema.sql`.
- The old look is on purpose: beveled panels, navy title bars, Verdana/Courier type, and tiny underlined links.

## Troubleshooting

**"SETUP REQUIRED" will not go away**
`js/config.js` is missing or still has the placeholder URL/key, or the file was cached. On Render, changing environment variables requires **Manual Deploy -> Clear build cache & deploy**. Then hard-refresh.

**Profile save says columns are missing**
Re-run `supabase/schema.sql`; the newer `profiles` columns have not been added to that project yet.

**Image upload says storage is not ready**
Re-run the storage section of `supabase/schema.sql` so the public `epick` bucket and its folder policies exist.

**Rank options do nothing**
Only the owner and co-owners can change ranks, and you cannot change your own. If nobody is owner yet, press **claim ownership** on your profile card.

**"Database error saving new user"**
The username is probably taken. Re-run the latest `schema.sql` so the `username_available` function exists, then try a different username.

**No messages show up**
Run the realtime section of `schema.sql` again, then hard-refresh. Also confirm the sender is a member of the room (public rooms auto-join when you click them).

**Login works but the chat screen is empty**
Open the browser console. Usually this means `schema.sql` was not run against the same Supabase project that is in `js/config.js`.

**Private room invite code**
The code is shown in the room header after you create the room. Friends enter it with **join by invite code** in the left column.
