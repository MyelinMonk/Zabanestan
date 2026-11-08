# Setting up reader accounts

Accounts are optional for readers. They let people sign in with Google and keep texts, word lists and OCR models online, each one private, unlisted (anyone with the link) or public (in the shared library once the team approves it). Until the steps below are done, the reader simply doesn't show them.

You need a free [Supabase](https://supabase.com) project, a Google Cloud project for "Sign in with Google", and about half an hour.

## 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) and create a new project, for example `zabanestan-reader`. Choose a region near most members, and keep the database password somewhere safe.
2. Open **SQL Editor**, start a new query, paste all of [`schema.sql`](schema.sql) and run it. It creates the tables, the rules for who can see and change what, and the `ocr-models` storage bucket. Running it again later is safe.

## 2. Turn on Sign in with Google

1. In the [Google Cloud console](https://console.cloud.google.com), create a project (for example "Zabanestan reader").
2. Set up the consent screen (**Google Auth Platform**, or **APIs & Services › OAuth consent screen**): app name "Zabanestan", a support email, and audience **External**. Then publish the app, so anyone with a Google account can sign in, not only test users. The reader asks only for the basic sign-in details (name, email address and profile picture), which don't need Google's review.
3. Create an **OAuth client** of type **Web application**:
   - Authorized JavaScript origins: `https://myelinmonk.github.io`
   - Authorized redirect URIs: the callback URL Supabase shows on its Google provider page, which looks like `https://YOUR-PROJECT.supabase.co/auth/v1/callback`
4. In Supabase, open **Authentication › Sign In / Providers › Google**, turn it on, and paste the client ID and client secret.
5. In **Authentication › URL Configuration**, set the Site URL to `https://myelinmonk.github.io/Zabanestan/khwanish/`, and add the same address under Redirect URLs.

## 3. Connect the reader

1. In Supabase's project settings, find the **project URL** and the **publishable key** (called the anon key in older projects). Both are meant to be public: the rules in `schema.sql` decide what each person can do. Never use the secret (service role) key; `build.py` refuses it.
2. Put them in `_khwanish/site-config.json`:

   ```json
   {
     "supabase": {
       "url": "https://YOUR-PROJECT.supabase.co",
       "key": "sb_publishable_..."
     }
   }
   ```

3. Rebuild the website copy, as in the [README](../README.md):

   ```
   python3 build.py --site
   rm -rf ../khwanish && cp -r dist/site ../khwanish
   ```

4. In the site's `_config.yml`, set `reader_accounts: true`, so the reader guide describes accounts.
5. Commit and push. Once GitHub Pages has updated, open the reader, go to **Options › Account** and sign in.

## 4. Choose the review team

Public resources join the shared library only after someone on the review team approves them. To add someone, have them sign in to the reader once, then run this in the SQL Editor with their Google address:

```sql
update public.profiles set is_moderator = true
where id = (select id from auth.users where email = 'someone@example.com');
```

Reviewers see a **Waiting for review** list on their account page. They can approve, decline with a note, or take something down, but they can't edit anyone's resources or see private ones. Their own public resources are approved straight away.

## Good to know

- **What's stored.** For each account: the Google email address, which only that person and the project's admins can see; an optional display name, blank by default, so people appear as "A Zabanestan member"; and whatever they share. Reading progress and flashcards are never uploaded.
- **Deleting.** People can delete their account from their account page, which removes everything they shared. Admins can delete any row in the dashboard's Table Editor.
- **Limits on the free plan.** 500 MB of database and 1 GB of files, with each model file up to 50 MB. Each account can keep up to 1,000 resources, and a text can be up to a million characters. Supabase pauses free projects that go unused for about a week; you can restore one from the dashboard without losing anything.
- **Testing the rules.** `test_schema.mjs` checks `schema.sql` in a real Postgres running in Node: `npm install @electric-sql/pglite`, then `node test_schema.mjs`.
