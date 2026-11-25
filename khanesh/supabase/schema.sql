-- Khānesh reader accounts: the database for a Supabase project.
-- Run it once in the Supabase dashboard (SQL Editor › New query › paste › Run). Running it again is safe.
-- See SETUP-ACCOUNTS.md for the rest of the setup.
--
--   profiles    one row per account: an optional display name (left blank, it shows as
--               "A Zabanestan member") and whether the person is on the review team.
--   resources   texts, word lists and OCR models kept in an account. Each one is
--                 private   only its owner can open it
--                 unlisted  anyone with its link can open it; it's never listed
--                 public    anyone with its link can open it, and the shared library lists it
--                           once the review team has approved it
--   ocr-models  a storage bucket for model files, one folder per account.
--   glosses     meanings people choose to share for words, with an optional dialect or place,
--               Persian equivalent and source; shown to everyone as suggestions. gloss_reports
--               lets members flag a wrong or abusive one.
--   reader_docs the reader's own saved data for people who sign in: settings, texts, words and
--               flashcards, so they can read on any device. Only the account's owner can see it.
--   speaker_consents  the consent forms speakers send from the site (record.html), each with a speaker
--               ID; only the team can read them. recordings: a private storage bucket for their files.
--   app_settings  private settings, such as the Discord webhook for notices to the team.
--
-- Unlisted resources (and public ones waiting for review) are read only through
-- get_resource(id), so nobody can list them. The review team sees everything that isn't
-- private, and can approve, reject or remove it, but can't edit it.

-- ---------- types ----------
do $$ begin create type public.visibility as enum ('private', 'unlisted', 'public'); exception when duplicate_object then null; end $$;
do $$ begin create type public.resource_kind as enum ('text', 'wordlist', 'ocr_model'); exception when duplicate_object then null; end $$;
do $$ begin create type public.review_state as enum ('none', 'pending', 'approved', 'rejected'); exception when duplicate_object then null; end $$;

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 60),
  is_moderator boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
-- the forum shows an Owner badge for this account (set in the dashboard, like is_moderator)
alter table public.profiles add column if not exists is_owner boolean not null default false;
-- the forum picture you chose: a file in the avatars bucket, in your own folder (set by forum_set_avatar)
alter table public.profiles add column if not exists avatar text check (avatar is null or avatar ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$');

drop policy if exists "read your profile" on public.profiles;
create policy "read your profile" on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists "change your name" on public.profiles;
create policy "change your name" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- people may change their display name and nothing else; the review team is set in the dashboard
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- no name from the sign-in provider: people choose whether to show one
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_moderator() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_moderator from public.profiles p where p.id = auth.uid()), false)
$$;

-- names to show beside shared resources, for the ids asked about (profiles can't be listed)
create or replace function public.display_names(ids uuid[]) returns table (id uuid, display_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name from public.profiles p where p.id = any (ids[1:200])
$$;

-- ---------- resources ----------
create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind public.resource_kind not null,
  lang text not null check (lang ~ '^([a-z]{2,3}(-[a-z0-9]{1,8})*|x-[a-z0-9-]{1,30})$'),
  lang_name text not null default '' check (char_length(lang_name) <= 80),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  source text not null default '' check (char_length(source) <= 1000),
  license text not null default '' check (char_length(license) <= 100),
  rights_confirmed boolean not null default false,
  visibility public.visibility not null default 'private',
  review public.review_state not null default 'none',
  review_note text not null default '' check (char_length(review_note) <= 1000),
  content jsonb check (content is null or pg_column_size(content) <= 5242880),
  word_count integer not null default 0 check (word_count >= 0),
  file_path text unique,
  file_name text check (file_name is null or char_length(file_name) <= 200),
  file_size bigint check (file_size is null or file_size between 0 and 52428800),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- (added separately so that running this file again updates them)
-- texts carry their text, word lists their words, models a stored file
alter table public.resources drop constraint if exists content_fits_kind;
alter table public.resources add constraint content_fits_kind check (
  case kind
    when 'text' then jsonb_typeof(content -> 'text') is not distinct from 'string'
    when 'wordlist' then jsonb_typeof(content -> 'words') is not distinct from 'array'
    when 'ocr_model' then file_path is not null
  end);
-- anything others can open needs a license and the owner's word that they may share it
alter table public.resources drop constraint if exists shared_needs_rights;
alter table public.resources add constraint shared_needs_rights check (visibility = 'private' or (license <> '' and rights_confirmed));
create index if not exists resources_library on public.resources (lang, kind, updated_at desc) where visibility = 'public' and review = 'approved';
create index if not exists resources_owner on public.resources (owner, updated_at desc);
create index if not exists resources_queue on public.resources (updated_at) where visibility = 'public' and review = 'pending';
alter table public.resources enable row level security;

drop policy if exists "read yours, the library, or review" on public.resources;
create policy "read yours, the library, or review" on public.resources for select
  using (owner = (select auth.uid())
         or (visibility = 'public' and review = 'approved')
         or (visibility <> 'private' and (select public.is_moderator())));
drop policy if exists "add your own" on public.resources;
create policy "add your own" on public.resources for insert to authenticated
  with check (owner = (select auth.uid()));
drop policy if exists "change yours, or review" on public.resources;
create policy "change yours, or review" on public.resources for update to authenticated
  using (owner = (select auth.uid()) or (visibility <> 'private' and (select public.is_moderator())))
  with check (owner = (select auth.uid()) or (select public.is_moderator()));
drop policy if exists "remove yours, or take down" on public.resources;
create policy "remove yours, or take down" on public.resources for delete to authenticated
  using (owner = (select auth.uid()) or (visibility <> 'private' and (select public.is_moderator())));

-- Keeps the review honest: owners can't approve their own resources, and changing a public
-- one sends it back for review. The review team changes only the review of others' resources.
create or replace function public.resources_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  team boolean := public.is_moderator();
  verdict public.review_state;
  note text;
begin
  -- edits from the dashboard or with the service key have no signed-in user: no rules apply
  -- (signed-out visitors can't write at all; the policies stop them)
  if me is null then return new; end if;
  if tg_op = 'UPDATE' and old.owner is distinct from me then
    if not team then raise exception 'Only the owner can change this.'; end if;
    if new.review not in ('approved', 'rejected') then raise exception 'A review approves or rejects.'; end if;
    verdict := new.review;
    note := new.review_note;
    new := old;
    new.review := verdict;
    new.review_note := note;
    new.updated_at := now();
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.kind <> old.kind or new.owner <> old.owner) then
    raise exception 'A resource keeps its kind and owner.';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    if (select count(*) from public.resources r where r.owner = new.owner) >= 1000 then
      raise exception 'An account can keep up to 1,000 resources.';
    end if;
  end if;
  new.updated_at := now();
  if new.visibility = 'public' then
    if tg_op = 'INSERT' or old.visibility <> 'public'
       or new.title is distinct from old.title or new.description is distinct from old.description
       or new.source is distinct from old.source or new.license is distinct from old.license
       or new.lang is distinct from old.lang or new.content is distinct from old.content
       or new.file_path is distinct from old.file_path then
      new.review := case when team then 'approved'::public.review_state else 'pending'::public.review_state end;
      new.review_note := '';
    else
      new.review := old.review;
      new.review_note := old.review_note;
    end if;
  else
    new.review := 'none';
    new.review_note := '';
  end if;
  return new;
end $$;
drop trigger if exists resources_guard on public.resources;
create trigger resources_guard before insert or update on public.resources
  for each row execute function public.resources_guard();

-- Open one resource by its id: yours, or anything that isn't private.
create or replace function public.get_resource(rid uuid) returns setof public.resources
language sql stable security definer set search_path = '' as $$
  select r.* from public.resources r
  where r.id = rid and (r.visibility <> 'private' or r.owner = auth.uid())
$$;

-- Delete your account. Your profile, name, picture, reading, what you've shared in the reader, votes and
-- reports always go. With keep_contributions, your forum posts and the meanings you shared stay, under
-- "A former member"; without it the meanings go and each post becomes "[Content deleted]", so threads
-- keep their shape.
-- (The page removes your model files and picture first.)
create or replace function public.delete_my_account(keep_contributions boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in.'; end if;
  if not coalesce(keep_contributions, false) then
    perform set_config('zabanestan.deleting', me::text, true);
    update public.forum_posts set body = '[Content deleted]', deleted = true where author = me;
    perform set_config('zabanestan.deleting', '', true);
    delete from public.glosses where author = me;
  end if;
  delete from auth.users where id = me;
end $$;
revoke execute on function public.delete_my_account(boolean) from public, anon;
grant execute on function public.delete_my_account(boolean) to authenticated;
-- (what the reader calls: everything goes)
create or replace function public.delete_my_account() returns void
language sql security definer set search_path = '' as $$ select public.delete_my_account(false) $$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.get_resource(uuid) to anon, authenticated;
grant execute on function public.display_names(uuid[]) to anon, authenticated;

-- the forum's badges beside names: 'owner' or 'moderator', for the ids asked about that have one
create or replace function public.forum_badges(ids uuid[]) returns table (id uuid, badge text)
language sql stable security definer set search_path = '' as $$
  select p.id, case when p.is_owner then 'owner' else 'moderator' end
    from public.profiles p where p.id = any (ids[1:200]) and (p.is_owner or p.is_moderator)
$$;
grant execute on function public.forum_badges(uuid[]) to anon, authenticated;

-- ---------- forum pictures ----------
-- Small pictures beside names in the forum. Anyone can see them (the bucket is public); each member
-- adds and removes files in their own folder; the team can remove any. The page shrinks a picture to
-- a small square before sending it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 204800, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "add your picture" on storage.objects;
create policy "add your picture" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists "see your pictures" on storage.objects;
create policy "see your pictures" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = (select auth.uid()::text) or public.is_moderator()));
drop policy if exists "remove a picture" on storage.objects;
create policy "remove a picture" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and ((storage.foldername(name))[1] = (select auth.uid()::text) or public.is_moderator()));

-- Choose your picture (a file you added to your folder), or none.
create or replace function public.forum_set_avatar(path text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if path is not null and split_part(path, '/', 1) <> auth.uid()::text then raise exception 'That picture isn’t yours.'; end if;
  update public.profiles set avatar = nullif(path, '') where id = auth.uid();
end $$;
revoke execute on function public.forum_set_avatar(text) from public, anon;
grant execute on function public.forum_set_avatar(text) to authenticated;

-- The team takes down someone's picture.
create or replace function public.forum_clear_avatar(member uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_moderator() then raise exception 'Only the team can remove someone’s picture.'; end if;
  update public.profiles set avatar = null where id = member;
end $$;
revoke execute on function public.forum_clear_avatar(uuid) from public, anon;
grant execute on function public.forum_clear_avatar(uuid) to authenticated;

-- Everything the forum shows beside a name: the name, a badge ('owner', 'moderator' or none) and the picture.
create or replace function public.forum_people(ids uuid[]) returns table (id uuid, display_name text, badge text, avatar text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.display_name,
         case when p.is_owner then 'owner' when p.is_moderator then 'moderator' end,
         p.avatar
    from public.profiles p where p.id = any (ids[1:200])
$$;
grant execute on function public.forum_people(uuid[]) to anon, authenticated;

-- ---------- OCR model files ----------
-- Files live under <account id>/<random id>.<ext>. Owners manage their folder; anyone may download
-- a file whose resource isn't private; the review team may remove shared files.
insert into storage.buckets (id, name, public, file_size_limit)
values ('ocr-models', 'ocr-models', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create or replace function public.file_is_shared(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.resources r where r.file_path = path and r.visibility <> 'private')
$$;
grant execute on function public.file_is_shared(text) to anon, authenticated;

drop policy if exists "ocr models: upload to your folder" on storage.objects;
create policy "ocr models: upload to your folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'ocr-models' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists "ocr models: replace in your folder" on storage.objects;
create policy "ocr models: replace in your folder" on storage.objects for update to authenticated
  using (bucket_id = 'ocr-models' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'ocr-models' and (storage.foldername(name))[1] = (select auth.uid()::text));
drop policy if exists "ocr models: download yours or shared" on storage.objects;
create policy "ocr models: download yours or shared" on storage.objects for select
  using (bucket_id = 'ocr-models' and ((storage.foldername(name))[1] = (select auth.uid()::text) or public.file_is_shared(name)));
drop policy if exists "ocr models: remove yours, or take down" on storage.objects;
create policy "ocr models: remove yours, or take down" on storage.objects for delete to authenticated
  using (bucket_id = 'ocr-models' and ((storage.foldername(name))[1] = (select auth.uid()::text)
         or ((select public.is_moderator()) and public.file_is_shared(name))));


-- =====================================================================================
-- Forum: boards, threads and posts. Anyone can read; signed-in members post; the review
-- team (profiles.is_moderator) moderates. Posts are plain text: the site shows them as text
-- with links, never as HTML.
-- =====================================================================================
create table if not exists public.forum_boards (
  id text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  title text not null,
  native text not null default '',
  description text not null default '',
  sort integer not null default 0,
  thread_count integer not null default 0,
  last_post_at timestamptz
);
alter table public.forum_boards enable row level security;
drop policy if exists "boards are public" on public.forum_boards;
create policy "boards are public" on public.forum_boards for select using (true);
revoke insert, update, delete on public.forum_boards from anon, authenticated;
-- three general boards, then one per language on the roster (_data/languages.yml)
insert into public.forum_boards (id, title, native, description, sort) values
  ('general', 'General', '', 'Introductions, news and anything about our languages', 1),
  ('learning', 'Learning and resources', '', 'Study tips, textbooks, dictionaries and questions about learning', 2),
  ('reader', 'Help desk', '', 'Ask questions about the site or report bugs.', 3),
  ('koroshi', 'Koroshi', '', '', 100),
  ('munji', 'Munji', '', '', 101),
  ('ishkashimi', 'Ishkashimi', '', '', 102),
  ('kumzari', 'Kumzari', '', '', 103),
  ('rushani', 'Rushani', '', '', 104),
  ('kate', 'Katë', '', '', 105),
  ('zoroastrian-dari', 'Zoroastrian Dari', '', '', 106),
  ('semnani', 'Semnani', 'سمنی زفون', '', 107),
  ('achomi', 'Achomi', 'اچُمی', '', 108),
  ('yaghnobi', 'Yaghnobi', 'Яғнобӣ зивок', '', 109),
  ('gorani', 'Gorani', 'گۆرانی', '', 110),
  ('wakhi', 'Wakhi', 'ښیکوار', '', 111),
  ('mazandarani', 'Mazandarani', 'مازِرونی', '', 112),
  ('sarikoli', 'Sarikoli', '', '', 113),
  ('shughni', 'Shughni', '', '', 114),
  ('southern-kurdish', 'Southern Kurdish', '', '', 115),
  ('taleshi', 'Taleshi', 'Tolışə Zıvon', '', 116),
  ('gilaki', 'Gilaki', 'گیلکی', '', 117),
  ('zazaki', 'Zazaki', 'Zazakî', '', 118),
  ('ossetian', 'Ossetian', 'ирон ӕвзаг', '', 119)
on conflict (id) do update set title = excluded.title, native = excluded.native, description = excluded.description, sort = excluded.sort;
-- each language's board takes posts in English, Persian or that language
update public.forum_boards set description = 'Posts in English, Persian or ' || title || ' only.' where sort >= 100;

create table if not exists public.forum_threads (
  id uuid primary key default gen_random_uuid(),
  board text not null references public.forum_boards (id) on delete cascade,
  author uuid references auth.users (id) on delete set null,
  title text not null check (char_length(title) between 3 and 200),
  pinned boolean not null default false,
  locked boolean not null default false,
  hidden boolean not null default false,
  post_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_post_at timestamptz not null default now()
);
-- languages taken off the roster: their boards go too, unless someone has already started a thread there
delete from public.forum_boards b
  where b.id in ('balochi', 'luri', 'sorani', 'hazaragi', 'laki', 'kurmanji', 'yazghulami')
    and not exists (select 1 from public.forum_threads t where t.board = b.id);
create index if not exists forum_threads_board on public.forum_threads (board, pinned desc, last_post_at desc);
alter table public.forum_threads enable row level security;

create table if not exists public.forum_posts (
  id uuid primary key default gen_random_uuid(),
  thread uuid not null references public.forum_threads (id) on delete cascade,
  -- empty once its author deletes their account but keeps their posts ("A former member")
  author uuid default auth.uid() references auth.users (id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 20000),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
-- (for a database made before posts could outlive their author's account)
-- a post whose author deleted their account with all their data: its text is gone
alter table public.forum_posts add column if not exists deleted boolean not null default false;
alter table public.forum_posts alter column author drop not null;
alter table public.forum_posts drop constraint if exists forum_posts_author_fkey;
alter table public.forum_posts add constraint forum_posts_author_fkey foreign key (author) references auth.users (id) on delete set null;
create index if not exists forum_posts_thread on public.forum_posts (thread, created_at);
create index if not exists forum_posts_author on public.forum_posts (author, created_at desc);
alter table public.forum_posts enable row level security;

create table if not exists public.forum_reports (
  id uuid primary key default gen_random_uuid(),
  post uuid not null references public.forum_posts (id) on delete cascade,
  reporter uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reason text not null default '' check (char_length(reason) <= 1000),
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  unique (post, reporter)
);
alter table public.forum_reports enable row level security;

-- Reading: everything that isn't hidden; your own hidden posts; the team sees all.
create or replace function public.forum_thread_visible(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.forum_threads x where x.id = t and (not x.hidden or public.is_moderator()))
$$;
drop policy if exists "read threads" on public.forum_threads;
create policy "read threads" on public.forum_threads for select
  using (not hidden or author = (select auth.uid()) or (select public.is_moderator()));
drop policy if exists "team manages threads" on public.forum_threads;
create policy "team manages threads" on public.forum_threads for update to authenticated
  using ((select public.is_moderator())) with check ((select public.is_moderator()));
drop policy if exists "team deletes threads" on public.forum_threads;
create policy "team deletes threads" on public.forum_threads for delete to authenticated using ((select public.is_moderator()));
revoke insert on public.forum_threads from anon, authenticated;  -- threads start through forum_new_thread()

drop policy if exists "read posts" on public.forum_posts;
create policy "read posts" on public.forum_posts for select
  using (public.forum_thread_visible(thread) and (not hidden or author = (select auth.uid()) or (select public.is_moderator())));
drop policy if exists "reply" on public.forum_posts;
create policy "reply" on public.forum_posts for insert to authenticated
  with check (author = (select auth.uid()) and exists (
    select 1 from public.forum_threads x where x.id = thread and not x.hidden and (not x.locked or (select public.is_moderator()))));
drop policy if exists "edit yours, or moderate" on public.forum_posts;
create policy "edit yours, or moderate" on public.forum_posts for update to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()))
  with check (author = (select auth.uid()) or (select public.is_moderator()));
drop policy if exists "delete yours, or moderate" on public.forum_posts;
create policy "delete yours, or moderate" on public.forum_posts for delete to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()));

drop policy if exists "report a post" on public.forum_reports;
create policy "report a post" on public.forum_reports for insert to authenticated with check (reporter = (select auth.uid()));
drop policy if exists "team reads reports" on public.forum_reports;
create policy "team reads reports" on public.forum_reports for select to authenticated using ((select public.is_moderator()));
drop policy if exists "team resolves reports" on public.forum_reports;
create policy "team resolves reports" on public.forum_reports for update to authenticated
  using ((select public.is_moderator())) with check ((select public.is_moderator()));

-- Posts: authors edit only the text (marked as edited), the team only hides or shows;
-- a gentle limit against flooding; counts kept on threads and boards.
create or replace function public.forum_post_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); hide boolean;
begin
  -- an account deleted with its posts kept: the database empties the author, which is let through
  if tg_op = 'UPDATE' and new.author is null and old.author is not null and not exists (select 1 from auth.users u where u.id = old.author) then return new; end if;
  if me is null then return new; end if;  -- the dashboard
  if tg_op = 'INSERT' then
    if (select count(*) from public.forum_posts p where p.author = me and p.created_at > now() - interval '1 minute') >= 5 then
      raise exception 'You’re posting very quickly. Wait a minute and try again.';
    end if;
    new.created_at := now(); new.edited_at := null; new.hidden := false;
    return new;
  end if;
  if old.author = me then
    hide := case when public.is_moderator() then new.hidden else old.hidden end;
    if new.body is distinct from old.body then new.edited_at := now(); end if;
    new.thread := old.thread; new.author := old.author; new.created_at := old.created_at; new.hidden := hide;
    -- only deleting your account marks your posts deleted
    if coalesce(current_setting('zabanestan.deleting', true), '') <> me::text then new.deleted := old.deleted; end if;
    return new;
  end if;
  -- the review team, on someone else's post
  hide := new.hidden;
  new := old;
  new.hidden := hide;
  return new;
end $$;
drop trigger if exists forum_post_guard on public.forum_posts;
create trigger forum_post_guard before insert or update on public.forum_posts for each row execute function public.forum_post_guard();

create or replace function public.forum_post_counts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.forum_threads set post_count = post_count + 1, last_post_at = new.created_at where id = new.thread;
    update public.forum_boards b set last_post_at = new.created_at from public.forum_threads t where t.id = new.thread and b.id = t.board;
  elsif tg_op = 'DELETE' then
    update public.forum_threads set post_count = greatest(post_count - 1, 0) where id = old.thread;
  end if;
  return null;
end $$;
drop trigger if exists forum_post_counts on public.forum_posts;
create trigger forum_post_counts after insert or delete on public.forum_posts for each row execute function public.forum_post_counts();

create or replace function public.forum_thread_counts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then update public.forum_boards set thread_count = thread_count + 1 where id = new.board;
  else update public.forum_boards set thread_count = greatest(thread_count - 1, 0) where id = old.board; end if;
  return null;
end $$;
drop trigger if exists forum_thread_counts on public.forum_threads;
create trigger forum_thread_counts after insert or delete on public.forum_threads for each row execute function public.forum_thread_counts();

-- the team may pin, lock or hide a thread; its board, author and title stay as they are
create or replace function public.forum_thread_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- an account deleted with its posts kept: the database empties the author, which is let through
  if tg_op = 'UPDATE' and new.author is null and old.author is not null and not exists (select 1 from auth.users u where u.id = old.author) then return new; end if;
  -- the dashboard, and the post counter (a trigger updating from another trigger), change anything
  if auth.uid() is null or pg_trigger_depth() > 1 then return new; end if;
  new.board := old.board; new.author := old.author; new.created_at := old.created_at;
  -- the title changes only through forum_rename_thread()
  if coalesce(current_setting('zabanestan.renaming', true), '') <> old.id::text then new.title := old.title; end if;
  new.post_count := old.post_count; new.last_post_at := old.last_post_at;
  return new;
end $$;
drop trigger if exists forum_thread_guard on public.forum_threads;
create trigger forum_thread_guard before update on public.forum_threads for each row execute function public.forum_thread_guard();

-- Start a thread: the thread and its first post together.
create or replace function public.forum_new_thread(board_id text, title text, body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); tid uuid;
begin
  if me is null then raise exception 'Sign in to start a thread.'; end if;
  if (select count(*) from public.forum_threads t where t.author = me and t.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You’ve started several threads in the last hour. Try again later.';
  end if;
  insert into public.forum_threads (board, author, title) values (board_id, me, btrim(title)) returning id into tid;
  insert into public.forum_posts (thread, author, body) values (tid, me, body);
  return tid;
end $$;
revoke execute on function public.forum_new_thread(text, text, text) from public, anon;
grant execute on function public.forum_new_thread(text, text, text) to authenticated;

-- Fix a thread's title: whoever started it, or the team.
create or replace function public.forum_rename_thread(thread_id uuid, new_title text) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); t public.forum_threads;
begin
  select * into t from public.forum_threads where id = thread_id;
  if me is null or t.id is null or not (t.author = me or public.is_moderator()) then
    raise exception 'Only whoever started this thread, or the team, can change its title.';
  end if;
  if char_length(btrim(coalesce(new_title, ''))) not between 3 and 200 then raise exception 'Give the thread a title.'; end if;
  perform set_config('zabanestan.renaming', thread_id::text, true);
  update public.forum_threads set title = btrim(new_title) where id = thread_id;
  perform set_config('zabanestan.renaming', '', true);
end $$;
revoke execute on function public.forum_rename_thread(uuid, text) from public, anon;
grant execute on function public.forum_rename_thread(uuid, text) to authenticated;

-- Delete a thread: the team, or whoever started it while no one else has posted in it.
create or replace function public.forum_delete_thread(thread_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); t public.forum_threads;
begin
  select * into t from public.forum_threads where id = thread_id;
  if me is null or t.id is null then raise exception 'This thread isn’t here.'; end if;
  if not public.is_moderator() then
    if t.author is distinct from me then raise exception 'Only whoever started this thread, or the team, can delete it.'; end if;
    if exists (select 1 from public.forum_posts p where p.thread = thread_id and p.author is distinct from me) then
      raise exception 'Others have replied, so the thread stays. Delete your own posts, or ask the team.';
    end if;
  end if;
  delete from public.forum_threads where id = thread_id;
end $$;
revoke execute on function public.forum_delete_thread(uuid) from public, anon;
grant execute on function public.forum_delete_thread(uuid) to authenticated;

-- ---------- the reader's saved data ----------
-- People who sign in keep their reading here: settings, lesson texts and details, words and
-- flashcards, and daily counts. The reader stores them as small documents (one per lesson part,
-- one per group of words), and only the account's owner can read or change them.
create table if not exists public.reader_docs (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 200),
  t text,   -- kind of document: set, stats, lm (lesson details), lt (lesson text), v (words)
  vl text,  -- for words, the language
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner, id),
  constraint reader_doc_size check (pg_column_size(data) <= 1048576)
);
create index if not exists reader_docs_kind on public.reader_docs (owner, t);
create index if not exists reader_docs_lang on public.reader_docs (owner, vl);
alter table public.reader_docs enable row level security;

drop policy if exists "read your reader data" on public.reader_docs;
create policy "read your reader data" on public.reader_docs for select to authenticated using (owner = (select auth.uid()));
drop policy if exists "add your reader data" on public.reader_docs;
create policy "add your reader data" on public.reader_docs for insert to authenticated with check (owner = (select auth.uid()));
drop policy if exists "change your reader data" on public.reader_docs;
create policy "change your reader data" on public.reader_docs for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
drop policy if exists "remove your reader data" on public.reader_docs;
create policy "remove your reader data" on public.reader_docs for delete to authenticated using (owner = (select auth.uid()));

-- Each account may keep up to 50 MB of reader data, so one account can't fill the database. Lesson
-- texts may use up to 45 MB of it, so there's always room left for words, flashcards and settings:
-- when an account is full, new texts stay on the person's device but their reading keeps syncing.
create or replace function public.reader_docs_quota() returns trigger
language plpgsql security definer set search_path = '' as $$
declare used bigint; used_texts bigint;
begin
  new.updated_at := now();
  new.t := new.data ->> 't';
  new.vl := new.data ->> 'vl';
  select coalesce(sum(pg_column_size(d.data)), 0),
         coalesce(sum(pg_column_size(d.data)) filter (where d.t = 'lt'), 0)
    into used, used_texts
    from public.reader_docs d where d.owner = new.owner and d.id <> new.id;
  if new.t = 'lt' and used_texts + pg_column_size(new.data) > 47185920 then
    raise exception 'Your reader storage is full.' using errcode = 'P0001', hint = 'quota_exceeded';
  end if;
  if used + pg_column_size(new.data) > 52428800 then
    raise exception 'Your reader storage is full.' using errcode = 'P0001', hint = 'quota_exceeded';
  end if;
  return new;
end $$;
drop trigger if exists reader_docs_quota on public.reader_docs;
create trigger reader_docs_quota before insert or update on public.reader_docs for each row execute function public.reader_docs_quota();

-- Change some fields of a document. Fields that hold objects (a group of words) are merged key by
-- key, so two devices saving different words don't overwrite each other. Returns false when the
-- document doesn't exist.
create or replace function public.reader_merge(doc_id text, patch jsonb) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare found_it boolean;
begin
  if jsonb_typeof(patch) <> 'object' then raise exception 'patch must be an object'; end if;
  update public.reader_docs d set data = d.data || (
      select coalesce(jsonb_object_agg(p.key,
        case when jsonb_typeof(d.data -> p.key) = 'object' and jsonb_typeof(p.value) = 'object'
             then (d.data -> p.key) || p.value else p.value end), '{}'::jsonb)
      from jsonb_each(patch) p)
    where d.owner = (select auth.uid()) and d.id = doc_id
    returning true into found_it;
  return coalesce(found_it, false);
end $$;
revoke execute on function public.reader_merge(text, jsonb) from public, anon;
grant execute on function public.reader_merge(text, jsonb) to authenticated;

-- How much of their storage someone is using, and their largest texts, for the reader's Options.
create or replace function public.reader_usage() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'used', coalesce((select sum(pg_column_size(data)) from public.reader_docs where owner = (select auth.uid())), 0),
    'texts', coalesce((select sum(pg_column_size(data)) from public.reader_docs where owner = (select auth.uid()) and t = 'lt'), 0),
    'limit', 52428800,
    'text_limit', 47185920,
    'largest', coalesce((
      select jsonb_agg(jsonb_build_object('lesson', lesson, 'bytes', bytes) order by bytes desc)
      from (select split_part(id, '.', 2) as lesson, sum(pg_column_size(data)) as bytes
              from public.reader_docs where owner = (select auth.uid()) and t = 'lt'
             group by 1 order by 2 desc limit 5) x), '[]'::jsonb));
$$;
revoke execute on function public.reader_usage() from public, anon;
grant execute on function public.reader_usage() to authenticated;

-- ---------- shared word meanings ----------
-- When someone chooses to share a word's meaning, it goes here, and anyone who taps the same word sees
-- it as a suggestion. One entry per person per word: sharing again updates it. Entries show right away.
-- Members vote suggestions up or down, which only changes their order; reports go to the team, who can
-- hide any entry. Neither votes nor reports hide anything on their own, so a group can't take one down.
create table if not exists public.glosses (
  id bigint generated always as identity primary key,
  -- empty once its author deletes their account but keeps what they shared
  author uuid default auth.uid() references auth.users (id) on delete set null,
  lang text not null check (lang ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  word_key text not null check (char_length(word_key) between 1 and 80),
  word text not null check (char_length(word) between 1 and 80),
  meaning text not null check (char_length(btrim(meaning)) between 1 and 300),
  dialect text not null default '' check (char_length(dialect) <= 80),
  persian text not null default '' check (char_length(persian) <= 80),
  source text not null default '' check (char_length(source) <= 200),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (author, lang, word_key)
);
create index if not exists glosses_lookup on public.glosses (lang, word_key) where not hidden;
alter table public.glosses alter column author drop not null;
alter table public.glosses drop constraint if exists glosses_author_fkey;
alter table public.glosses add constraint glosses_author_fkey foreign key (author) references auth.users (id) on delete set null;
alter table public.glosses enable row level security;

create table if not exists public.gloss_reports (
  id bigint generated always as identity primary key,
  gloss bigint not null references public.glosses (id) on delete cascade,
  reporter uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reason text not null default '' check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  unique (gloss, reporter)
);
alter table public.gloss_reports enable row level security;

-- Votes on a suggestion: a meaning for a word, whoever gave it. One vote per person, up (1) or down (-1).
create table if not exists public.gloss_votes (
  voter uuid not null default auth.uid() references auth.users (id) on delete cascade,
  lang text not null check (lang ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  word_key text not null check (char_length(word_key) between 1 and 80),
  meaning_key text not null check (char_length(meaning_key) between 1 and 300),
  vote smallint not null check (vote in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (voter, lang, word_key, meaning_key)
);
create index if not exists gloss_votes_lookup on public.gloss_votes (lang, word_key);
alter table public.gloss_votes enable row level security;

drop policy if exists "read shared meanings" on public.glosses;
create policy "read shared meanings" on public.glosses for select
  using (not hidden or author = (select auth.uid()) or (select public.is_moderator()));
drop policy if exists "share a meaning" on public.glosses;
create policy "share a meaning" on public.glosses for insert to authenticated
  with check (author = (select auth.uid()) and not hidden);
drop policy if exists "change yours, or moderate" on public.glosses;
create policy "change yours, or moderate" on public.glosses for update to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()))
  with check (author = (select auth.uid()) or (select public.is_moderator()));
drop policy if exists "remove yours, or moderate" on public.glosses;
create policy "remove yours, or moderate" on public.glosses for delete to authenticated
  using (author = (select auth.uid()) or (select public.is_moderator()));

drop policy if exists "your votes" on public.gloss_votes;
create policy "your votes" on public.gloss_votes for all to authenticated
  using (voter = (select auth.uid())) with check (voter = (select auth.uid()));
create or replace function public.gloss_votes_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.meaning_key := lower(btrim(new.meaning_key));
  if tg_op = 'INSERT' and (select count(*) from public.gloss_votes v where v.voter = new.voter and v.created_at > now() - interval '1 day') >= 1000 then
    raise exception 'You’ve voted a lot today. Try again tomorrow.';
  end if;
  return new;
end $$;
drop trigger if exists gloss_votes_guard on public.gloss_votes;
create trigger gloss_votes_guard before insert or update on public.gloss_votes for each row execute function public.gloss_votes_guard();

drop policy if exists "report a meaning" on public.gloss_reports;
create policy "report a meaning" on public.gloss_reports for insert to authenticated
  with check (reporter = (select auth.uid()));
drop policy if exists "team reads reports" on public.gloss_reports;
create policy "team reads reports" on public.gloss_reports for select to authenticated
  using ((select public.is_moderator()));
drop policy if exists "team clears reports" on public.gloss_reports;
create policy "team clears reports" on public.gloss_reports for delete to authenticated
  using ((select public.is_moderator()));

-- Only the team can hide or unhide an entry, and authors can't move one to another word or person.
-- New entries: at most 500 a day per person.
create or replace function public.glosses_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- an account deleted with its posts kept: the database empties the author, which is let through
  if tg_op = 'UPDATE' and new.author is null and old.author is not null and not exists (select 1 from auth.users u where u.id = old.author) then return new; end if;
  new.meaning := btrim(new.meaning);
  new.dialect := btrim(new.dialect);
  new.persian := btrim(new.persian);
  new.source := btrim(new.source);
  if tg_op = 'INSERT' then
    if not public.is_moderator() then new.hidden := false; end if;
    if (select count(*) from public.glosses g where g.author = new.author and g.created_at > now() - interval '1 day') >= 500 then
      raise exception 'You’ve shared a lot of words today. Try again tomorrow.';
    end if;
  else
    if not public.is_moderator() and pg_trigger_depth() <= 1 then
      new.hidden := old.hidden;
      new.author := old.author; new.lang := old.lang; new.word_key := old.word_key;
    end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
drop trigger if exists glosses_guard on public.glosses;
create trigger glosses_guard before insert or update on public.glosses for each row execute function public.glosses_guard();

-- Reports don't hide an entry by themselves (votes order the suggestions), so the trigger that did is removed.
drop trigger if exists gloss_reported on public.gloss_reports;
drop function if exists public.gloss_reported();

-- Suggestions for a list of words in one language: each distinct meaning, how many people gave it,
-- its up and down votes (votes from people who gave it don't count: they're already among them), your
-- own vote, and the dialects, Persian equivalents and sources given with it. Best first: people who
-- gave it, plus up votes, minus down votes.
drop function if exists public.gloss_suggestions(text, text[]);
create function public.gloss_suggestions(p_lang text, p_keys text[])
returns table (word_key text, meaning text, people int, ups int, downs int, my_vote int,
               dialects text[], persian text[], sources text[], ids bigint[], mine boolean)
language sql stable security definer set search_path = '' as $$
  with s as (
    select g.word_key, lower(g.meaning) as mk, min(g.meaning) as meaning, count(*)::int as people,
           array_remove(array_agg(distinct nullif(g.dialect, '')), null) as dialects,
           array_remove(array_agg(distinct nullif(g.persian, '')), null) as persian,
           array_remove(array_agg(distinct nullif(g.source, '')), null) as sources,
           array_agg(g.id order by g.id) as ids, array_agg(g.author) as authors,
           coalesce(bool_or(g.author = auth.uid()), false) as mine, min(g.created_at) as first
      from public.glosses g
     where g.lang = p_lang and g.word_key = any (p_keys[1:2000]) and not g.hidden
     group by g.word_key, lower(g.meaning)
  ), v as (
    select s.word_key, s.mk,
           (count(*) filter (where x.vote = 1))::int as ups,
           (count(*) filter (where x.vote = -1))::int as downs,
           max(x.vote) filter (where x.voter = auth.uid()) as mine_vote
      from s join public.gloss_votes x on x.lang = p_lang and x.word_key = s.word_key and x.meaning_key = s.mk
     where not (x.voter = any (s.authors))
     group by s.word_key, s.mk
  )
  select s.word_key, s.meaning, s.people, coalesce(v.ups, 0), coalesce(v.downs, 0), coalesce(v.mine_vote, 0)::int,
         s.dialects, s.persian, s.sources, s.ids, s.mine
    from s left join v on v.word_key = s.word_key and v.mk = s.mk
   order by s.word_key, s.people + coalesce(v.ups, 0) - coalesce(v.downs, 0) desc, s.people desc, s.first;
$$;
revoke execute on function public.gloss_suggestions(text, text[]) from public;
grant execute on function public.gloss_suggestions(text, text[]) to anon, authenticated;

-- ---------- consent forms and speakers' recordings ----------
-- The consent form on the site's record.html. Anyone can send it, without an account, through
-- submit_consent(), which checks the answers and returns a new speaker ID such as ZB-7KQM-3RXA.
-- Only the team (moderators) can read the forms; the admins see them in the Table Editor.
-- Recordings go in the private "recordings" bucket, in a folder named after the speaker ID. For a day
-- after sending the form, the speaker's page can add up to 10 files there; only the team can open them.
create table if not exists public.speaker_consents (
  id uuid primary key default gen_random_uuid(),
  speaker_id text not null unique check (speaker_id ~ '^ZB-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$'),
  created_at timestamptz not null default now(),
  form_version text not null default '' check (char_length(form_version) <= 40),  -- which wording they agreed to
  credit text not null check (credit in ('anonymous', 'nickname', 'full_name')),
  credit_name text not null default '' check (char_length(credit_name) <= 200),
  access text not null check (access in ('public', 'restricted', 'private')),
  uses text[] not null default '{}' check (uses <@ array['lessons', 'dictionaries', 'archive', 'wikimedia', 'other']),
  uses_other text not null default '' check (char_length(uses_other) <= 1000),
  language text not null check (char_length(language) between 1 and 200),
  region text not null default '' check (char_length(region) <= 300),
  age_range text not null check (age_range in ('13-17', '18-29', '30-44', '45-59', '60-74', '75+')),
  guardian_name text not null default '' check (char_length(guardian_name) <= 200),
  guardian_email text not null default '' check (char_length(guardian_email) <= 320),
  guardian_agreed boolean not null default false,
  video text not null check (video in ('face', 'no_face', 'audio_only', 'no_video')),
  email text not null default '' check (char_length(email) <= 320),
  recontact boolean not null default false,
  transcription text not null default '' check (char_length(transcription) <= 50000),
  translation text not null default '' check (char_length(translation) <= 50000),
  understood boolean not null,
  agreed boolean not null,
  files jsonb not null default '[]',      -- recordings added on the site: name, bytes, type, added_at
  withdrawn_at timestamptz,               -- set by the team when someone withdraws
  team_notes text not null default '',
  constraint confirmed check (understood and agreed),
  constraint credit_needs_name check (credit = 'anonymous' or credit_name <> ''),
  constraint other_use_needs_text check (not ('other' = any (uses)) or uses_other <> ''),
  constraint open_uses_need_public_access check (access = 'public' or not (uses && array['lessons', 'dictionaries', 'wikimedia'])),
  constraint minor_needs_guardian check (age_range <> '13-17' or (guardian_name <> '' and guardian_email <> '' and guardian_agreed)),
  constraint recontact_needs_email check (not recontact or email <> '')
);
create index if not exists speaker_consents_created on public.speaker_consents (created_at);
alter table public.speaker_consents enable row level security;
revoke all on public.speaker_consents from anon;
revoke insert, delete, truncate on public.speaker_consents from authenticated;
drop policy if exists "consent forms: the team reads them" on public.speaker_consents;
create policy "consent forms: the team reads them" on public.speaker_consents for select to authenticated
  using ((select public.is_moderator()));
drop policy if exists "consent forms: the team updates them" on public.speaker_consents;
create policy "consent forms: the team updates them" on public.speaker_consents for update to authenticated
  using ((select public.is_moderator())) with check ((select public.is_moderator()));

-- ---------- notices to the team (optional) ----------
-- With the pg_net extension switched on and a Discord webhook saved here, each new consent form and
-- recording posts a short notice to that channel: the speaker ID, language and access, never names
-- or emails. See SETUP-ACCOUNTS.md. Nothing here is visible through the API.
create table if not exists public.app_settings (key text primary key, value text not null default '');
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

create or replace function public.notify_team(msg text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare hook text;
begin
  select s.value into hook from public.app_settings s where s.key = 'discord_webhook';
  if coalesce(hook, '') !~ '^https://(discord\.com|discordapp\.com)/api/webhooks/' then return; end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'net' and p.proname = 'http_post') then return; end if;
  execute 'select net.http_post(url := $1, body := $2)'
    using hook, jsonb_build_object('content', left(msg, 1900), 'allowed_mentions', jsonb_build_object('parse', '[]'::jsonb));
exception when others then
  return;  -- a notice that can't be sent never stops a form or a recording from being saved
end $$;
revoke execute on function public.notify_team(text) from public, anon, authenticated;

-- ZB- and two groups of four, from 32 characters that can't be mistaken for each other (no 0, O, 1 or I)
create or replace function public.new_speaker_id() returns text
language plpgsql volatile set search_path = '' as $$
declare
  abc constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  b bytea := uuid_send(gen_random_uuid());
  s text := '';
  i int;
begin
  foreach i in array array[0, 1, 2, 3, 10, 11, 12, 13] loop  -- bytes without the UUID's fixed bits
    s := s || substr(abc, get_byte(b, i) % 32 + 1, 1);
  end loop;
  return 'ZB-' || left(s, 4) || '-' || right(s, 4);
end $$;
revoke execute on function public.new_speaker_id() from public, anon, authenticated;

-- The answers, as the form sends them: credit, credit_name, access, uses (a list), uses_other, language,
-- region, age_range, guardian_name, guardian_email, guardian_agreed, video, email, recontact,
-- transcription, translation, understood, agreed, form_version. Returns the new speaker ID.
create or replace function public.submit_consent(answers jsonb) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  sid text;
  tries int := 0;
  failed text;
  a jsonb := coalesce(answers, '{}');
  txt text[] := array['credit', 'credit_name', 'access', 'uses_other', 'language', 'region', 'age_range',
                      'guardian_name', 'guardian_email', 'video', 'email', 'transcription', 'translation', 'form_version'];
  k text;
begin
  foreach k in array txt loop  -- trim the text answers
    if jsonb_typeof(a -> k) = 'string' then a := jsonb_set(a, array[k], to_jsonb(btrim(a ->> k))); end if;
  end loop;
  if not (coalesce((a ->> 'understood')::boolean, false) and coalesce((a ->> 'agreed')::boolean, false)) then
    raise exception 'Please tick both boxes at the end of the form.';
  end if;
  if coalesce(a ->> 'email', '') !~ '^([^@\s]+@[^@\s]+\.[^@\s]+)?$' then
    raise exception 'That email address doesn''t look right.';
  end if;
  if coalesce(a ->> 'guardian_email', '') !~ '^([^@\s]+@[^@\s]+\.[^@\s]+)?$' then
    raise exception 'The parent''s or guardian''s email address doesn''t look right.';
  end if;
  if (select count(*) from public.speaker_consents c where c.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'A lot of forms have arrived in the last hour. Please try again later, or email us.';
  end if;
  loop
    sid := public.new_speaker_id();
    begin
      insert into public.speaker_consents (speaker_id, form_version, credit, credit_name, access, uses, uses_other,
          language, region, age_range, guardian_name, guardian_email, guardian_agreed, video, email, recontact,
          transcription, translation, understood, agreed)
      values (sid, coalesce(a ->> 'form_version', ''), a ->> 'credit', coalesce(a ->> 'credit_name', ''), a ->> 'access',
          array(select distinct u from jsonb_array_elements_text(case when jsonb_typeof(a -> 'uses') = 'array' then a -> 'uses' else '[]' end) u order by u),
          coalesce(a ->> 'uses_other', ''), coalesce(a ->> 'language', ''), coalesce(a ->> 'region', ''), a ->> 'age_range',
          coalesce(a ->> 'guardian_name', ''), coalesce(a ->> 'guardian_email', ''), coalesce((a ->> 'guardian_agreed')::boolean, false),
          a ->> 'video', coalesce(a ->> 'email', ''), coalesce((a ->> 'recontact')::boolean, false),
          coalesce(a ->> 'transcription', ''), coalesce(a ->> 'translation', ''), true, true);
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 5 then raise; end if;
    end;
  end loop;
  perform public.notify_team(format('New consent form: %s · %s · %s access', sid, a ->> 'language', a ->> 'access'));
  return sid;
exception
  when check_violation then
    get stacked diagnostics failed = constraint_name;
    raise exception '%', case failed
      when 'credit_needs_name' then 'Add the nickname or name you''d like to be credited by.'
      when 'other_use_needs_text' then 'Say what else we may use your recording for.'
      when 'open_uses_need_public_access' then 'Lessons, dictionaries and Wikimedia clips are open to everyone, so they need Public access.'
      when 'minor_needs_guardian' then 'For a speaker aged 13 to 17, a parent or guardian needs to give their name and email, and agree.'
      when 'recontact_needs_email' then 'Add your email, so we can contact you again.'
      else 'Some answers are missing or don''t fit together. Please check the form and try again.' end;
  when not_null_violation or invalid_text_representation then
    raise exception 'Some answers are missing. Please check the form and try again.';
end $$;
revoke execute on function public.submit_consent(jsonb) from public;
grant execute on function public.submit_consent(jsonb) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 52428800, array['audio/*', 'video/*'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- a recording may go in <speaker ID>/<file name> for a day after the form was sent, up to 10 files
create or replace function public.recording_upload_ok(object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select object_name ~ '^ZB-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
     and exists (select 1 from public.speaker_consents c
                  where c.speaker_id = split_part(object_name, '/', 1)
                    and c.withdrawn_at is null and c.created_at > now() - interval '1 day')
     and (select count(*) from storage.objects o
           where o.bucket_id = 'recordings' and split_part(o.name, '/', 1) = split_part(object_name, '/', 1)) < 10
$$;
grant execute on function public.recording_upload_ok(text) to anon, authenticated;
drop policy if exists "recordings: speakers add theirs" on storage.objects;
create policy "recordings: speakers add theirs" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'recordings' and public.recording_upload_ok(name));
drop policy if exists "recordings: the team opens them" on storage.objects;
create policy "recordings: the team opens them" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and (select public.is_moderator()));
drop policy if exists "recordings: the team removes them" on storage.objects;
create policy "recordings: the team removes them" on storage.objects for delete to authenticated
  using (bucket_id = 'recordings' and (select public.is_moderator()));

-- After a recording is uploaded, the page notes it on the form (and the team gets a notice)
create or replace function public.consent_file_added(p_speaker_id text, p_name text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  c record;
  o record;
begin
  select s.id, s.files into c from public.speaker_consents s
   where s.speaker_id = p_speaker_id and s.withdrawn_at is null and s.created_at > now() - interval '1 day';
  if not found then
    raise exception 'Files can be added here only on the day the form is sent. Please email your recording to us, with your speaker ID.';
  end if;
  select coalesce((x.metadata ->> 'size')::bigint, 0) as bytes, coalesce(x.metadata ->> 'mimetype', '') as type into o
    from storage.objects x where x.bucket_id = 'recordings' and x.name = p_speaker_id || '/' || p_name;
  if not found then raise exception 'That file didn''t arrive. Please try sending it again.'; end if;
  if not exists (select 1 from jsonb_array_elements(c.files) f where f ->> 'name' = p_name) then
    update public.speaker_consents
       set files = files || jsonb_build_array(jsonb_build_object('name', p_name, 'bytes', o.bytes, 'type', o.type, 'added_at', now()))
     where id = c.id;
    perform public.notify_team(format('Recording received for %s: %s (%s MB)', p_speaker_id, p_name, round(o.bytes / 1048576.0, 1)));
  end if;
end $$;
revoke execute on function public.consent_file_added(text, text) from public;
grant execute on function public.consent_file_added(text, text) to anon, authenticated;
