# Setting up accounts, the forum and the consent form

Accounts are optional. They let people sign in with Google to post in the forum, and to keep texts, word lists and OCR models in the reader, each one private, unlisted (anyone with the link) or public (in the shared library once the team approves it). The consent form for recording speakers (`record.html`) uses the same project, but no one needs an account to send it. Until the steps below are done, the site shows no sign-in, the forum page says it opens soon, and the consent form asks speakers to email instead.

You need a free [Supabase](https://supabase.com) project, a Google Cloud project for "Sign in with Google", and about half an hour.

## 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) and create a new project, for example `zabanestan-reader`. Choose a region near most members, and keep the database password somewhere safe.
2. Open **SQL Editor**, start a new query, paste all of [`schema.sql`](schema.sql) and run it. It creates the tables, the rules for who can see and change what, and the `ocr-models` and `recordings` storage buckets. Running it again later is safe, and it's how you add what's new, such as the consent form.

## 2. Turn on Sign in with Google

1. In the [Google Cloud console](https://console.cloud.google.com), create a project (for example "Zabanestan reader").
2. Set up the consent screen (**Google Auth Platform**, or **APIs & Services › OAuth consent screen**): app name "Zabanestan", a support email, and audience **External**. Then publish the app, so anyone with a Google account can sign in, not only test users. The reader asks only for the basic sign-in details (name, email address and profile picture), which don't need Google's review.
3. Create an **OAuth client** of type **Web application**:
   - Authorized JavaScript origins: your site's address, for example `https://zabanestan.org` and `https://www.zabanestan.org`
   - Authorized redirect URIs: the callback URL Supabase shows on its Google provider page, which looks like `https://YOUR-PROJECT.supabase.co/auth/v1/callback`
4. In Supabase, open **Authentication › Sign In / Providers › Google**, turn it on, and paste the client ID and client secret.
5. In **Authentication › URL Configuration**, set the Site URL to your site's address, for example `https://zabanestan.org/`, and under Redirect URLs add that address followed by `**` (for example `https://zabanestan.org/**`), so sign-in can return to both the reader and the forum.

## 3. Connect the reader

1. In Supabase's project settings, find the **project URL** and the **publishable key** (called the anon key in older projects). Both are meant to be public: the rules in `schema.sql` decide what each person can do. Never use the secret (service role) key; `build.py` refuses it.
2. Put them in the site's `_config.yml`:

   ```yaml
   supabase_url: "https://YOUR-PROJECT.supabase.co"
   supabase_key: "sb_publishable_..."
   ```

   This switches on the forum, the reader's account features and the reader guide's section on sharing.
3. Rebuild the reader, which reads the same two settings, as in the [README](../README.md):

   ```
   python3 build.py --site
   rm -rf ../khanesh && cp -r dist/site ../khanesh
   ```

4. Publish the site again (see `DEPLOY.md` at the top of the site's folder). Then open the reader, go to **Options › Account** and sign in.

## 4. Choose the review team

Public resources join the shared library only after someone on the review team approves them. To add someone, have them sign in to the reader once, then run this in the SQL Editor with their Google address:

```sql
update public.profiles set is_moderator = true
where id = (select id from auth.users where email = 'someone@example.com');
```

In the forum, reviewers are the moderators. On each thread they get a **Moderate** bar to edit the title, pin, lock, hide or delete it. They also get **Hide** under other people's posts, and **Reports** on the forum page. Their forum posts carry a **Moderator** badge. To give an account the **Owner** badge instead, run the same command with `set is_owner = true, is_moderator = true`. Members can choose a picture to show beside their posts (stored small, in the public **avatars** bucket); without one the forum shows a plain grey default picture, and moderators can take a picture down with **Remove picture** under that person's post. Anyone who starts a thread can fix its title, and can delete it while no one else has replied. Everyone can edit or delete their own posts. In the reader, reviewers see a **Waiting for review** list on their account page. They can approve, decline with a note, or take something down, but they can't edit anyone's resources or see private ones. Their own public resources are approved straight away.

## 5. Consent forms and recordings

The consent form is on the site at `record.html`. It works as soon as `schema.sql` has been run (run it again if you set up accounts before the form existed) and the site has the two Supabase settings above.

- **What happens.** Each form gets a speaker ID, such as `ZB-7KQM-3RXA`, which the speaker sees straight away and can save with a copy of their answers. Recordings they add on the page go to the private `recordings` storage bucket, in a folder named after their speaker ID: up to 10 files of up to 50 MB each, on the day they send the form. Later or bigger files come by email, with the speaker ID in the subject line.
- **Seeing the forms.** In Supabase, open **Table Editor › speaker_consents**. The recordings are under **Storage › recordings**, one folder per speaker ID. Only the project's admins and the review team can open either. Not even the speaker can read a form back, so nobody else who learns a speaker ID can either.
- **Changes and withdrawals.** When someone writes with their speaker ID, change their row in the Table Editor. For a withdrawal, set `withdrawn_at` to the date, delete their folder in Storage, and take the recording down wherever you've used it. `team_notes` is for your own notes.
- **Speakers aged 13 to 17** give a parent's or guardian's name and email. The form tells them you'll email the parent or guardian to confirm before using the recording, so do that first. For a child under 13, the form asks the parent or guardian to email you instead.
- **Space.** Recordings share the free plan's 1 GB of files with the reader's OCR models. Move older recordings somewhere safe, such as a backed-up drive or an archive deposit, before it fills up, then delete them from Storage. Each form keeps its list of files.
- **Changing the wording.** The text of the form is in `record.html`. If you change it, change `consent_version` at the top of that file too: each form saves the date of the wording the speaker agreed to.

### Notices in Discord (optional)

To get a message in a Discord channel when a form or a recording arrives, with the speaker ID, language and access but never names or emails:

1. In Discord, open the settings of a private channel only the team can see, then **Integrations › Webhooks › New Webhook**, and **Copy Webhook URL**.
2. In Supabase, open **Database › Extensions** and switch on **pg_net**.
3. In the SQL Editor, run this with the webhook's address:

   ```sql
   insert into public.app_settings (key, value) values ('discord_webhook', 'https://discord.com/api/webhooks/...')
   on conflict (key) do update set value = excluded.value;
   ```

Keep the webhook's address private, like a password: anyone who has it can post in that channel. To stop the notices, delete that row under **Table Editor › app_settings**.

## Good to know

- **What's stored.** For each account: the Google email address, which only that person and the project's admins can see; a display name, blank until they choose one (the forum asks for one, which can be a nickname, before someone first posts); their forum posts; whatever they share from the reader; and, once they sign in to the reader, their texts, words and flashcards (up to 50 MB each, of which texts may use 45 MB), which only they can see. When an account is full, new texts stay on that person's device and their words keep syncing.
- **Deleting.** People can delete their account from the reader's account page, which removes everything they shared and their forum posts. Threads they started stay, without their name, while others have replied. Admins can delete any row in the dashboard's Table Editor.
- **Limits on the free plan.** 500 MB of database and 1 GB of files, with each model file up to 50 MB. Each account can keep up to 1,000 resources, and a text can be up to a million characters. Supabase pauses free projects that go unused for about a week; you can restore one from the dashboard without losing anything.
- **Testing the rules.** `test_schema.mjs` checks `schema.sql` in a real Postgres running in Node: `npm install @electric-sql/pglite`, then `node test_schema.mjs`.


## Google's own Sign in button

The site signs people in with Google's own button (google-signin.js), so Google's screen names the site
rather than the Supabase address. It needs the OAuth client's **Client ID** in `_config.yml`
(`google_client_id`; never the secret) and `https://zabanestan.org` (plus the www address) under that client's
**Authorized JavaScript origins** in Google Cloud Console. Supabase's Google provider must list the same
Client ID, which it does once Google sign-in is set up. If the button can't load, **Sign in another way**
uses Google's sign-in pages as before.
