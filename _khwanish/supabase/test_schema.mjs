// Checks schema.sql in a real Postgres (PGlite, Postgres compiled to WebAssembly), with the
// parts of Supabase it relies on recreated: the anon and authenticated roles, auth.users,
// auth.uid() and storage.objects. Run: node test_schema.mjs (after npm install @electric-sql/pglite)
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth; create schema storage;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text not null, owner uuid);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema public, auth, storage to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`);
const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
await db.exec(sql);
await db.exec(sql); // running it twice must be safe

const A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b';
const M = '00000000-0000-4000-8000-00000000000c';
for (const id of [A, B, M]) await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [id, id.slice(-1) + '@example.com', { full_name: 'Real Name ' + id.slice(-1) }]);
await db.query('update public.profiles set is_moderator = true where id = $1', [M]);

let fails = 0;
const check = (name, ok, info) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : '  [' + JSON.stringify(info) + ']')); if (!ok) fails++; };
async function as(who, q, params = []) {
  await db.exec('reset role');
  if (who === 'anon') await db.exec("set role anon; select set_config('request.jwt.claim.sub', '', false)");
  else if (who === 'admin') await db.exec("select set_config('request.jwt.claim.sub', '', false)");
  else await db.query("select set_config('request.jwt.claim.sub', $1, false)", [who]).then(() => db.exec('set role authenticated'));
  try { return await db.query(q, params); } finally { await db.exec('reset role'); }
}
async function fails_(who, q, params) { try { await as(who, q, params); return false; } catch (e) { return e.message; } }
const rows = r => r.rows;

// profiles
const prof = rows(await as(A, 'select * from public.profiles'));
check('new account gets a profile with no name', prof.length === 1 && prof[0].display_name === '' && prof[0].id === A, prof);
check('profiles of others are hidden', rows(await as(A, 'select * from public.profiles where id = $1', [B])).length === 0);
await as(A, "update public.profiles set display_name = 'Austin' where id = $1", [A]);
check('you can set your display name', rows(await as('admin', 'select display_name from public.profiles where id = $1', [A]))[0].display_name === 'Austin');
check("you can't make yourself a reviewer", !!(await fails_(A, 'update public.profiles set is_moderator = true where id = $1', [A])));
const names = rows(await as('anon', 'select * from public.display_names($1)', [[A, B]]));
check('names for shared resources', names.length === 2 && names.find(n => n.id === A).display_name === 'Austin', names);

// a private text
const t1 = rows(await as(A, `insert into public.resources (kind, lang, title, content, word_count) values ('text', 'fa', 'گلستان', '{"text": "بنی آدم اعضای یکدیگرند"}', 4) returning id, review, owner`))[0];
check('owner adds a private text', t1.review === 'none' && t1.owner === A, t1);
check('owner sees it', rows(await as(A, 'select id from public.resources')).length === 1);
check('others cannot list it', rows(await as(B, 'select id from public.resources')).length === 0);
check('others cannot open it by link', rows(await as(B, 'select id from public.get_resource($1)', [t1.id])).length === 0);
check('signed-out visitors cannot open it', rows(await as('anon', 'select id from public.get_resource($1)', [t1.id])).length === 0);
check('the review team cannot see private texts', rows(await as(M, 'select id from public.resources')).length === 0);
check('a text needs its text', !!(await fails_(A, `insert into public.resources (kind, lang, title, content) values ('text', 'fa', 'x', '{"words": []}')`)));
check('sharing needs a license and the rights', !!(await fails_(A, "update public.resources set visibility = 'unlisted' where id = $1", [t1.id])));
check('language codes are checked', !!(await fails_(A, `insert into public.resources (kind, lang, title, content) values ('text', 'Persian!', 'x', '{"text": "a"}')`)));
check('others cannot change it', rows(await as(B, "update public.resources set title = 'hacked' where id = $1 returning id", [t1.id])).length === 0);
check('others cannot delete it', rows(await as(B, 'delete from public.resources where id = $1 returning id', [t1.id])).length === 0);

// unlisted
await as(A, "update public.resources set visibility = 'unlisted', license = 'Public domain', rights_confirmed = true where id = $1", [t1.id]);
check('unlisted: not listed for others', rows(await as(B, 'select id from public.resources')).length === 0);
check('unlisted: not listed for visitors', rows(await as('anon', 'select id from public.resources')).length === 0);
check('unlisted: opens by link for others', rows(await as(B, 'select title from public.get_resource($1)', [t1.id]))[0]?.title === 'گلستان');
check('unlisted: opens by link signed out', rows(await as('anon', 'select title from public.get_resource($1)', [t1.id])).length === 1);

// public, with review
const pub = rows(await as(A, "update public.resources set visibility = 'public' where id = $1 returning review", [t1.id]))[0];
check('public: waits for review', pub.review === 'pending', pub);
check('public: owner cannot approve it', rows(await as(A, "update public.resources set review = 'approved' where id = $1 returning review", [t1.id]))[0].review === 'pending');
check('public: not in the library yet', rows(await as('anon', "select id from public.resources where visibility = 'public' and review = 'approved'")).length === 0);
check('public: opens by link while waiting', rows(await as('anon', 'select id from public.get_resource($1)', [t1.id])).length === 1);
check('public: in the review queue', rows(await as(M, "select id from public.resources where review = 'pending'")).length === 1);
check('reviewers cannot edit', rows(await as(M, "update public.resources set title = 'changed', review = 'approved' where id = $1 returning title, review", [t1.id]))[0]?.title === 'گلستان');
check('reviewers can approve', rows(await as('admin', 'select review from public.resources where id = $1', [t1.id]))[0].review === 'approved');
check('public: in the library once approved', rows(await as('anon', "select id from public.resources where visibility = 'public' and review = 'approved'")).length === 1);
check('public: listed for other accounts', rows(await as(B, 'select id from public.resources')).length === 1);
await as(A, "update public.resources set description = 'Saadi' where id = $1", [t1.id]);
check('editing a public text sends it back for review', rows(await as('admin', 'select review from public.resources where id = $1', [t1.id]))[0].review === 'pending');
await as(M, "update public.resources set review = 'rejected', review_note = 'Please add the edition' where id = $1", [t1.id]);
const rej = rows(await as(A, 'select review, review_note from public.resources where id = $1', [t1.id]))[0];
check('owner sees the rejection note', rej.review === 'rejected' && rej.review_note === 'Please add the edition', rej);
check('reviewers only approve or reject', !!(await fails_(M, "update public.resources set review = 'none' where id = $1", [t1.id])));
await as(A, "update public.resources set visibility = 'private' where id = $1", [t1.id]);
check('making it private ends the review', rows(await as('admin', 'select review from public.resources where id = $1', [t1.id]))[0].review === 'none');
check('the dashboard can still edit', rows(await as('admin', "update public.resources set title = 'گلستان سعدی' where id = $1 returning title", [t1.id]))[0].title === 'گلستان سعدی');

// a word list, shared by a reviewer: approved straight away
const wl = rows(await as(M, `insert into public.resources (kind, lang, title, content, visibility, license, rights_confirmed) values ('wordlist', 'mzn', 'Numbers', '{"words": [["یکی", "one"]]}', 'public', 'CC BY-SA 4.0', true) returning id, review`))[0];
check("the review team's own posts are approved", wl.review === 'approved', wl);

// OCR model files
const path = `${A}/4f1c.safetensors`, pathB = `${B}/x.safetensors`;
check('upload to your own folder', !(await fails_(A, "insert into storage.objects (bucket_id, name) values ('ocr-models', $1)", [path])));
check("can't upload to someone else's folder", !!(await fails_(A, "insert into storage.objects (bucket_id, name) values ('ocr-models', $1)", [pathB])));
const m1 = rows(await as(A, `insert into public.resources (kind, lang, title, file_path, file_name, file_size) values ('ocr_model', 'fa', 'Naskh', $1, 'naskh.safetensors', 1000) returning id`, [path]))[0];
check('owner can download a private model', rows(await as(A, "select name from storage.objects where bucket_id = 'ocr-models'")).length === 1);
check("others can't download a private model", rows(await as('anon', 'select name from storage.objects where name = $1', [path])).length === 0);
await as(A, "update public.resources set visibility = 'unlisted', license = 'CC BY 4.0', rights_confirmed = true where id = $1", [m1.id]);
check('anyone can download a shared model', rows(await as('anon', 'select name from storage.objects where name = $1', [path])).length === 1);
check("others can't delete your model file", rows(await as(B, 'delete from storage.objects where name = $1 returning name', [path])).length === 0);
check('a model needs its file', !!(await fails_(A, "insert into public.resources (kind, lang, title) values ('ocr_model', 'fa', 'x')")));

// deleting an account
await as(B, `insert into public.resources (kind, lang, title, content) values ('text', 'fr', 'Le Corbeau', '{"text": "Maître Corbeau"}')`);
await as(B, 'select public.delete_my_account()');
check('deleting your account removes it and its resources', rows(await as('admin', 'select count(*)::int as n from public.resources where owner = $1', [B]))[0].n === 0 && rows(await as('admin', 'select count(*)::int as n from auth.users where id = $1', [B]))[0].n === 0);
check("signed-out visitors can't delete accounts", !!(await fails_('anon', 'select public.delete_my_account()')));

console.log(`\n${fails} failures`);
process.exit(fails ? 1 : 0);
