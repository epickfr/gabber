# Epick Chat

An intentionally old-looking chat site: HTML 4.01, table layout, underlined blue links, monospace chat lines, and a marquee. Under the crust it is plain HTML/CSS/JS with Supabase for accounts, storage, and realtime.

The old look is a style choice, not a claim about the code's age.

## What it does

- Email/password accounts with a unique username
- Friends: search users, send requests, accept/decline, remove friends
- Direct messages between friends
- Public rooms anyone can join
- Private rooms with an invite code
- Live messages and online dots via Supabase Realtime
- Chat history stored in Postgres, so Render redeploys do not wipe it
- Row Level Security: users can only read rooms/DMs they belong to

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
  index.html              the whole UI (login + chat)
  styles.css              small, deliberately barebones stylesheet
  js/config.example.js    copy to js/config.js for local development
  js/config.js            generated / gitignored (your local values)
  js/app.js               auth, rooms, friends, DMs, realtime
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
   - This creates the tables, policies, realtime setup, the `#lobby` room, and a trigger that gives every new user a profile.
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
- The old look is on purpose. The HTML 4.01 doctype, `<center>`, `<font>`, tables, marquee, and tiny underlined links are all part of it.

## Troubleshooting

**"SETUP REQUIRED" will not go away**
`js/config.js` is missing or still has the placeholder URL/key, or the file was cached. Hard-refresh.

**"Database error saving new user"**
The username is probably taken. Re-run the latest `schema.sql` so the `username_available` function exists, then try a different username.

**No messages show up**
Run the realtime section of `schema.sql` again, then hard-refresh. Also confirm the sender is a member of the room (public rooms auto-join when you click them).

**Login works but the chat screen is empty**
Open the browser console. Usually this means `schema.sql` was not run against the same Supabase project that is in `js/config.js`.

**Private room invite code**
The code is shown in the room header after you create the room. Friends enter it with **join by invite code** in the left column.
