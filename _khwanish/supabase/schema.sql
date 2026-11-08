-- Khwānish reader accounts: the database for a Supabase project.
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

-- Delete your account, with everything in it. (The reader removes your model files first.)
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in.'; end if;
  delete from auth.users where id = auth.uid();
end $$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
grant execute on function public.get_resource(uuid) to anon, authenticated;
grant execute on function public.display_names(uuid[]) to anon, authenticated;

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
