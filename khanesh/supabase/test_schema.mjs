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
  create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text not null, owner uuid, metadata jsonb);
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
await as(A, "update public.profiles set display_name = 'Darya' where id = $1", [A]);
check('you can set your display name', rows(await as('admin', 'select display_name from public.profiles where id = $1', [A]))[0].display_name === 'Darya');
check("you can't make yourself a reviewer", !!(await fails_(A, 'update public.profiles set is_moderator = true where id = $1', [A])));
const names = rows(await as('anon', 'select * from public.display_names($1)', [[A, B]]));
check('names for shared resources', names.length === 2 && names.find(n => n.id === A).display_name === 'Darya', names);

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

// the forum
const C = '00000000-0000-4000-8000-00000000000d', E = '00000000-0000-4000-8000-00000000000e';
for (const id of [C, E]) await db.query('insert into auth.users (id) values ($1)', [id]);
check('boards are public', rows(await as('anon', 'select id from public.forum_boards')).length === 23);
check('signed-out visitors can\'t start threads', !!(await fails_('anon', "select public.forum_new_thread('general', 'Hello', 'Hi')")));
check('threads start only through the function', !!(await fails_(A, "insert into public.forum_threads (board, author, title) values ('general', $1, 'Sneaky')", [A])));
const tid = rows(await as(A, "select public.forum_new_thread('mazandarani', 'Pazevari''s couplets', 'Which edition do you use?') as id"))[0].id;
// badges beside names in the forum
await as('admin', 'update public.profiles set is_owner = true, is_moderator = true where id = $1', [A]);
const badges = Object.fromEntries(rows(await as('anon', 'select id, badge from public.forum_badges($1)', [[A, M, C]])).map(r => [r.id, r.badge]));
check('the owner and moderators get badges, others none', badges[A] === 'owner' && badges[M] === 'moderator' && !(C in badges), badges);
check("members can't give themselves a badge", !!(await fails_(C, 'update public.profiles set is_owner = true where id = $1', [C])));
await as('admin', 'update public.profiles set is_owner = false, is_moderator = false where id = $1', [A]);
// forum pictures
check('pictures go in your own folder', !(await fails_(B, "insert into storage.objects (bucket_id, name) values ('avatars', $1)", [B + '/1.webp']))
  && !!(await fails_(B, "insert into storage.objects (bucket_id, name) values ('avatars', $1)", [E + '/1.webp'])));
check('the team can remove any picture file', rows(await as(M, "delete from storage.objects where bucket_id = 'avatars' and name = $1 returning name", [B + '/1.webp'])).length === 1);
await as(B, 'select public.forum_set_avatar($1)', [B + '/1.webp']);
check('you can choose a picture from your folder', rows(await as('anon', 'select avatar from public.forum_people($1)', [[B]]))[0].avatar === B + '/1.webp');
check("you can't choose someone else's file", !!(await fails_(B, 'select public.forum_set_avatar($1)', [E + '/1.webp'])));
check("you can't set the picture directly", !!(await fails_(B, 'update public.profiles set avatar = null where id = $1', [B])));
check("members can't take down someone's picture", !!(await fails_(E, 'select public.forum_clear_avatar($1)', [B])));
await as(M, 'select public.forum_clear_avatar($1)', [B]);
check('the team can take down a picture', rows(await as('anon', 'select avatar from public.forum_people($1)', [[B]]))[0].avatar === null);
const ppl = rows(await as('anon', 'select id, display_name, badge from public.forum_people($1)', [[M, E]]));
check('names and badges come with the pictures', ppl.find(r => r.id === M).badge === 'moderator' && ppl.find(r => r.id === E).badge === null, ppl);
// fixing a title, and deleting a thread no one else has posted in
const typo = rows(await as(A, "select public.forum_new_thread('general', 'Zabanestan corse is out', 'Hello') as id"))[0].id;
check("others can't rename your thread", !!(await fails_(C, "select public.forum_rename_thread($1, 'Hijacked')", [typo])));
check("a title can't be changed by a plain update", rows(await as(A, "update public.forum_threads set title = 'Sneaky' where id = $1 returning title", [typo])).length === 0
  && rows(await as('anon', 'select title from public.forum_threads where id = $1', [typo]))[0].title === 'Zabanestan corse is out');
await as(A, "select public.forum_rename_thread($1, '  Zabanestan course is out  ')", [typo]);
check('whoever started a thread can fix its title', rows(await as('anon', 'select title from public.forum_threads where id = $1', [typo]))[0].title === 'Zabanestan course is out');
check('titles still need 3 letters', !!(await fails_(A, "select public.forum_rename_thread($1, 'x')", [typo])));
check("others can't delete your thread", !!(await fails_(C, 'select public.forum_delete_thread($1)', [typo])));
await as(C, 'insert into public.forum_posts (thread, body) values ($1, $2)', [typo, 'Congratulations!']);
check("once others reply, you can't delete the thread", !!(await fails_(A, 'select public.forum_delete_thread($1)', [typo])));
await as(M, "select public.forum_rename_thread($1, 'Renamed by the team')", [typo]);
check('the team can rename any thread', rows(await as('anon', 'select title from public.forum_threads where id = $1', [typo]))[0].title === 'Renamed by the team');
const solo = rows(await as(A, "select public.forum_new_thread('general', 'Only me here', 'Hello') as id"))[0].id;
await as(A, 'select public.forum_delete_thread($1)', [solo]);
check('you can delete a thread only you have posted in', rows(await as('admin', 'select id from public.forum_threads where id = $1', [solo])).length === 0);
await as(M, 'select public.forum_delete_thread($1)', [typo]);
check('the team can delete any thread', rows(await as('admin', 'select id from public.forum_threads where id = $1', [typo])).length === 0);
check('a new thread opens with its first post', rows(await as('anon', 'select title, post_count from public.forum_threads where id = $1', [tid]))[0]?.post_count === 1);
check('anyone can read it', rows(await as('anon', 'select body from public.forum_posts where thread = $1', [tid]))[0]?.body === 'Which edition do you use?');
check('the board counts it', rows(await as('anon', "select thread_count from public.forum_boards where id = 'mazandarani'"))[0].thread_count === 1);
check('signed-out visitors can\'t reply', !!(await fails_('anon', 'insert into public.forum_posts (thread, author, body) values ($1, $2, $3)', [tid, A, 'x'])));
const reply = rows(await as(C, 'insert into public.forum_posts (thread, body) values ($1, $2) returning id, author', [tid, "Nima Yushij's."]))[0];
check('members reply', reply.author === C && rows(await as('anon', 'select post_count from public.forum_threads where id = $1', [tid]))[0].post_count === 2);
check("can't post as someone else", !!(await fails_(C, 'insert into public.forum_posts (thread, author, body) values ($1, $2, $3)', [tid, A, 'forged'])));
check('blank posts are refused', !!(await fails_(C, 'insert into public.forum_posts (thread, body) values ($1, $2)', [tid, '   '])));
const ed = rows(await as(C, "update public.forum_posts set body = 'Edited' where id = $1 returning body, edited_at, hidden", [reply.id]))[0];
check('authors edit their posts, marked as edited', ed.body === 'Edited' && ed.edited_at !== null);
check("authors can't hide their own posts", rows(await as(C, 'update public.forum_posts set hidden = true where id = $1 returning hidden', [reply.id]))[0].hidden === false);
const first = rows(await as('admin', 'select id from public.forum_posts where thread = $1 and author = $2', [tid, A]))[0].id;
check("others' posts can't be edited", rows(await as(C, "update public.forum_posts set body = 'x' where id = $1 returning id", [first])).length === 0);
check("others' posts can't be deleted", rows(await as(C, 'delete from public.forum_posts where id = $1 returning id', [first])).length === 0);
await as(C, 'insert into public.forum_reports (post, reason) values ($1, $2)', [first, 'test report']);
check('members can\'t read reports', rows(await as(A, 'select id from public.forum_reports')).length === 0);
check('the team reads reports', rows(await as(M, 'select reason from public.forum_reports'))[0]?.reason === 'test report');
check('the team resolves reports', rows(await as(M, 'update public.forum_reports set resolved = true returning resolved'))[0]?.resolved === true);
const hid = rows(await as(M, "update public.forum_posts set hidden = true, body = 'rewritten' where id = $1 returning hidden, body", [reply.id]))[0];
check("the team hides posts but can't rewrite them", hid.hidden === true && hid.body === 'Edited', hid);
check('hidden posts disappear for others', rows(await as('anon', 'select id from public.forum_posts where id = $1', [reply.id])).length === 0);
check('authors still see their hidden post', rows(await as(C, 'select id from public.forum_posts where id = $1', [reply.id])).length === 1);
check("members can't pin or lock", rows(await as(C, 'update public.forum_threads set pinned = true where id = $1 returning id', [tid])).length === 0);
const lk = rows(await as(M, "update public.forum_threads set locked = true, pinned = true, title = 'changed' where id = $1 returning locked, pinned, title", [tid]))[0];
check("the team pins and locks, but doesn't retitle", lk.locked && lk.pinned && lk.title === "Pazevari's couplets", lk);
check('locked threads take no replies', !!(await fails_(C, 'insert into public.forum_posts (thread, body) values ($1, $2)', [tid, 'late'])));
check('the team can still reply', !(await fails_(M, 'insert into public.forum_posts (thread, body) values ($1, $2)', [tid, 'Locked for now.'])));
await as(M, 'update public.forum_threads set hidden = true where id = $1', [tid]);
check('hidden threads disappear with their posts', rows(await as('anon', 'select id from public.forum_threads where id = $1', [tid])).length === 0 && rows(await as('anon', 'select id from public.forum_posts where thread = $1', [tid])).length === 0);
await as(M, 'update public.forum_threads set hidden = false, locked = false where id = $1', [tid]);
const t2 = rows(await as(E, "select public.forum_new_thread('general', 'Flood test', 'one') as id"))[0].id;
for (let i = 0; i < 4; i++) await as(E, 'insert into public.forum_posts (thread, body) values ($1, $2)', [t2, 'post ' + i]);
check('posting very fast is slowed down', /very quickly/.test(await fails_(E, 'insert into public.forum_posts (thread, body) values ($1, $2)', [t2, 'too fast']) || ''));
await as(C, 'select public.delete_my_account()');
check("deleting an account removes that member's posts", rows(await as('admin', 'select count(*)::int as n from public.forum_posts where author = $1', [C]))[0].n === 0);
await as(A, 'select 1');

// the reader's saved data
await as(A, `insert into public.reader_docs (id, data) values ('v.fa.8.3', '{"t": "v", "vl": "fa", "w": {"سلام": [3, 1], "کتاب": [1, 1]}}')`);
const rd = rows(await as(A, "select t, vl, data from public.reader_docs where id = 'v.fa.8.3'"))[0];
check('reader documents are filed by kind and language', rd?.t === 'v' && rd?.vl === 'fa', rd);
check("others can't see your reader data", rows(await as(B, 'select id from public.reader_docs')).length === 0);
check("signed-out visitors can't see reader data", !!(await fails_('anon', 'select id from public.reader_docs')) || rows(await as('anon', 'select id from public.reader_docs')).length === 0);
check("others can't write into your reader data", !!(await fails_(B, `insert into public.reader_docs (owner, id, data) values ($1, 'x', '{}')`, [A])));
const merged = rows(await as(A, `select public.reader_merge('v.fa.8.3', '{"w": {"کتاب": [2, 5], "آب": [1, 5]}}') as ok`))[0].ok;
const w = rows(await as(A, "select data->'w' as w from public.reader_docs where id = 'v.fa.8.3'"))[0].w;
check('merging keeps other words and updates the changed ones', merged === true && w['سلام'][0] === 3 && w['کتاب'][0] === 2 && w['آب'][0] === 1, w);
check('merging into a missing document reports it', rows(await as(A, `select public.reader_merge('nope', '{"w": {}}') as ok`))[0].ok === false);
check("merging can't reach someone else's document", rows(await as(B, `select public.reader_merge('v.fa.8.3', '{"w": {"x": [1]}}') as ok`))[0].ok === false);
check("signed-out visitors can't merge", !!(await fails_('anon', `select public.reader_merge('v.fa.8.3', '{"w": {}}')`)));
await as(B, `insert into public.reader_docs (id, data) values ('settings', '{"t": "set"}')`);

// a full account: texts stop at 45 MB, words still fit up to 50 MB
const F = '00000000-0000-4000-8000-0000000000f1';
await db.query('insert into auth.users (id, email) values ($1, $2)', [F, 'full@example.com']);
// texts are stored compressed, so make them varied
const chunk = i => Array.from({ length: 4000 }, (_, k) => ((k * 7919 + i * 104729) % 1000003).toString(36)).join(' ');
let n = 0, refused = null;
for (; n < 400; n++) {
  const err = await fails_(F, `insert into public.reader_docs (id, data) values ($1, jsonb_build_object('t', 'lt', 's', $2::text))`, ['lt.big' + n + '.0', chunk(n).repeat(8)]);
  if (err) { refused = err; break; }
}
const u1 = rows(await as(F, 'select public.reader_usage() as u'))[0].u;
check('texts stop before the account is full', !!refused && /storage is full/.test(refused) && u1.texts <= 47185920 && u1.texts > 40000000, [n, u1.texts, refused]);
check('words still fit after texts are full', !(await fails_(F, `insert into public.reader_docs (id, data) values ('v.fa.8.0', '{"t": "v", "vl": "fa", "w": {"a": [1]}}')`)));
check('usage lists the largest texts', u1.largest.length === 5 && u1.largest[0].bytes >= u1.largest[4].bytes && u1.limit === 52428800, u1.largest);
check("usage is only your own", rows(await as(B, 'select public.reader_usage() as u'))[0].u.used < 1000);
check("signed-out visitors can't read usage", !!(await fails_('anon', 'select public.reader_usage()')));

// shared word meanings
const share = (u, key, meaning, extra = {}) => as(u, `insert into public.glosses (lang, word_key, word, meaning, dialect, persian, source)
  values ('mzn', $1, $1, $2, $3, $4, $5)
  on conflict (author, lang, word_key) do update set meaning = excluded.meaning, dialect = excluded.dialect, persian = excluded.persian, source = excluded.source`,
  [key, meaning, extra.dialect || '', extra.persian || '', extra.source || '']);
await share(A, 'دار', 'tree', { dialect: 'Sari', persian: 'درخت', source: 'Nasri Ashrafi' });
await share(E, 'دار', ' tree ', { dialect: 'Amol' });
await share(M, 'دار', 'wood');
const sug = rows(await as('anon', "select * from public.gloss_suggestions('mzn', array['دار', 'نیست'])"));
check('suggestions group the same meaning and count the people', sug.length === 2 && sug[0].meaning === 'tree' && sug[0].people === 2 && sug[1].meaning === 'wood', sug);
check('suggestions bring dialects, Persian equivalents and sources', JSON.stringify(sug[0].dialects.sort()) === '["Amol","Sari"]' && sug[0].persian[0] === 'درخت' && sug[0].sources[0] === 'Nasri Ashrafi', sug[0]);
check('signed-out visitors can read suggestions but not share', !!(await fails_('anon', "insert into public.glosses (lang, word_key, word, meaning) values ('mzn', 'x', 'x', 'y')")));
await share(A, 'دار', 'tree (the plant)');
check('sharing the same word again updates your entry', rows(await as('admin', "select count(*)::int as n from public.glosses where author = $1", [A]))[0].n === 1);
const mine = rows(await as(A, "select mine from public.gloss_suggestions('mzn', array['دار']) where meaning = 'tree (the plant)'"))[0];
check('suggestions say which one is yours', mine && mine.mine === true, mine);
check("you can't hide your own entry from the team's view, or unhide", (await as(A, "update public.glosses set hidden = true where author = $1", [A]), rows(await as('admin', 'select hidden from public.glosses where author = $1', [A]))[0].hidden === false));
check("you can't change someone else's entry", (await as(B, "update public.glosses set meaning = 'spam' where author = $1", [M]), rows(await as('admin', 'select meaning from public.glosses where author = $1', [M]))[0].meaning === 'wood'));
check('meanings must have some text', !!(await fails_(B, "insert into public.glosses (lang, word_key, word, meaning) values ('mzn', 'x', 'x', '   ')")));
const wood = rows(await as('admin', "select id from public.glosses where author = $1", [M]))[0].id;
for (const u of [A, B, E]) await as(u, 'insert into public.gloss_reports (gloss, reason) values ($1, $2)', [wood, 'wrong']);
check('reports alone never hide a meaning', rows(await as('anon', "select * from public.gloss_suggestions('mzn', array['دار']) where meaning = 'wood'")).length === 1);
check("members can't read reports", rows(await as(B, 'select * from public.gloss_reports')).length === 0);
check('the team reads reports', rows(await as(M, 'select * from public.gloss_reports')).length === 3);
// votes order the suggestions; they never hide one
const order = async () => rows(await as('anon', "select meaning, people, ups, downs from public.gloss_suggestions('mzn', array['دار'])")).map(r => r.meaning);
const before = await order();
const vote = (u, meaning, v) => as(u, `insert into public.gloss_votes (lang, word_key, meaning_key, vote) values ('mzn', 'دار', $1, $2)
  on conflict (voter, lang, word_key, meaning_key) do update set vote = excluded.vote`, [meaning, v]);
const loser = before[0], winner = before[before.length - 1];
for (const u of [E, B]) await vote(u, ' ' + winner.toUpperCase() + ' ', 1);
for (const u of [E, B]) await vote(u, loser, -1);
const after = await order();
check('up and down votes reorder suggestions', after[0] === winner && after[after.length - 1] === loser, { before, after });
check('down votes never hide a meaning', after.length === before.length);
const mv = rows(await as(E, "select meaning, ups, downs, my_vote from public.gloss_suggestions('mzn', array['دار'])"));
check('you see your own vote, and the counts', mv.find(r => r.meaning === winner).my_vote === 1 && mv.find(r => r.meaning === loser).my_vote === -1 && mv.find(r => r.meaning === winner).ups === 2, mv);
await vote(E, winner, -1);
check('changing your vote replaces it', rows(await as(E, "select ups, downs from public.gloss_suggestions('mzn', array['دار']) where meaning = $1", [winner]))[0].downs === 1);
await as(E, "delete from public.gloss_votes where word_key = 'دار' and meaning_key = $1", [winner.toLowerCase()]);
check('you can take your vote back', rows(await as(E, "select my_vote from public.gloss_suggestions('mzn', array['دار']) where meaning = $1", [winner]))[0].my_vote === 0);
check("votes are private: you can't read others'", rows(await as(E, 'select * from public.gloss_votes')).every(r => r.voter === E) && rows(await as(E, 'select * from public.gloss_votes')).length > 0);
check("you can't vote as someone else", !!(await fails_(E, "insert into public.gloss_votes (voter, lang, word_key, meaning_key, vote) values ($1, 'mzn', 'دار', 'x', 1)", [B])));
check('votes are only up or down', !!(await fails_(E, "insert into public.gloss_votes (lang, word_key, meaning_key, vote) values ('mzn', 'دار', 'y', 5)")));
check("signed-out visitors can't vote", !!(await fails_('anon', "insert into public.gloss_votes (lang, word_key, meaning_key, vote) values ('mzn', 'دار', 'y', 1)")));
const tree = rows(await as('admin', "select meaning from public.glosses where author = $1", [A]))[0].meaning;
await vote(A, tree, 1);
check("voting for a meaning you gave doesn't count twice", rows(await as('anon', "select ups from public.gloss_suggestions('mzn', array['دار']) where meaning = $1", [tree]))[0].ups === 0);
check('the team can still hide a meaning', (await as(M, 'update public.glosses set hidden = true where id = $1', [wood]), rows(await as('anon', "select * from public.gloss_suggestions('mzn', array['دار']) where meaning = 'wood'")).length === 0));
await as(M, 'update public.glosses set hidden = false where id = $1', [wood]);

// consent forms and recordings
const form = { credit: 'nickname', credit_name: ' Dino ', access: 'public', uses: ['lessons', 'archive', 'lessons'], language: 'Mazandarani (Babol)',
  region: 'Babol', age_range: '30-44', video: 'no_video', email: 'dino@example.com', recontact: true, understood: true, agreed: true, form_version: '2026-11-14' };
const send = (who, f) => as(who, 'select public.submit_consent($1) as sid', [f]).then(r => r.rows[0].sid);
const SID = /^ZB-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const sid = await send('anon', form);
check('anyone can send the consent form, and gets a speaker ID', SID.test(sid), sid);
const saved = rows(await as(M, 'select * from public.speaker_consents where speaker_id = $1', [sid]))[0];
check('the team sees the form as sent, trimmed and without repeats', saved && saved.credit_name === 'Dino' && saved.uses.join() === 'archive,lessons' && saved.recontact === true && saved.form_version === '2026-11-14', saved);
check("signed-out visitors can't read consent forms", !!(await fails_('anon', 'select * from public.speaker_consents')));
check("members can't read them either", rows(await as(A, 'select * from public.speaker_consents')).length === 0);
check("visitors can't write to the table directly", !!(await fails_('anon', "insert into public.speaker_consents (speaker_id, credit, access, language, age_range, video, understood, agreed) values ('ZB-2222-2222', 'anonymous', 'private', 'x', '18-29', 'no_video', true, true)")));
check("members can't change a form", (await as(A, "update public.speaker_consents set access = 'private'"), rows(await as('admin', 'select access from public.speaker_consents where speaker_id = $1', [sid]))[0].access === 'public'));
check('the team can note a withdrawal', (await as(M, 'update public.speaker_consents set team_notes = $2 where speaker_id = $1', [sid, 'checked']), rows(await as('admin', 'select team_notes from public.speaker_consents where speaker_id = $1', [sid]))[0].team_notes === 'checked'));
check('signed-in members can send it too', SID.test(await send(A, { ...form, credit: 'anonymous', credit_name: '', recontact: false, email: '' })));
check('speaker IDs differ', (await send('anon', form)) !== sid);
const refuses = async (patch, why, says) => { const m = await fails_('anon', 'select public.submit_consent($1)', [{ ...form, ...patch }]); check(why, !!m && (!says || m.includes(says)), m); };
await refuses({ credit_name: '  ' }, 'a nickname needs the name', 'nickname or name');
await refuses({ access: 'restricted' }, 'lessons need public access', 'need Public access');
await refuses({ access: 'private', uses: ['wikimedia'] }, 'Wikimedia clips need public access', 'need Public access');
await refuses({ uses: ['other'], uses_other: '' }, '"something else" needs saying what', 'what else');
await refuses({ age_range: '13-17' }, 'a speaker under 18 needs a parent or guardian', 'parent or guardian');
await refuses({ age_range: '13-17', guardian_name: 'Parent', guardian_email: 'p@example.com' }, 'and the parent or guardian has to agree', 'parent or guardian');
check('a speaker aged 13 to 17 can send it with a parent or guardian', SID.test(await send('anon', { ...form, age_range: '13-17', guardian_name: 'Parent', guardian_email: 'p@example.com', guardian_agreed: true })));
await refuses({ age_range: 'under-13' }, 'no forms for children under 13');
await refuses({ recontact: true, email: '' }, 'being contacted again needs an email', 'Add your email');
await refuses({ email: 'dino at example' }, 'emails are checked', "doesn't look right");
await refuses({ agreed: false }, 'both boxes at the end must be ticked', 'both boxes');
await refuses({ understood: null }, 'both boxes, really', 'both boxes');
await refuses({ uses: ['lessons', 'speech'] }, 'only the listed uses');
await refuses({ credit: null }, 'missing answers are refuses', 'missing');
await refuses({ recontact: 'maybe' }, 'nonsense answers are refuses', 'missing');

const up = (who, name, bytes = 1000) => as(who, "insert into storage.objects (bucket_id, name, metadata) values ('recordings', $1, $2)", [name, { size: bytes, mimetype: 'audio/mpeg' }]);
const bucket = rows(await as('admin', "select * from storage.buckets where id = 'recordings'"))[0];
check('the recordings bucket is private, 50 MB a file, audio and video only', bucket && bucket.public === false && Number(bucket.file_size_limit) === 52428800 && bucket.allowed_mime_types.join() === 'audio/*,video/*', bucket);
check('the speaker can add a recording to their folder', (await up('anon', sid + '/1700000000000-story.mp3'), true));
check('not to a folder with no form', !!(await fails_('anon', "insert into storage.objects (bucket_id, name) values ('recordings', 'ZB-2222-2222/x.mp3')")));
check('not with an odd file name', !!(await fails_('anon', "insert into storage.objects (bucket_id, name) values ('recordings', $1)", [sid + '/../x.mp3'])));
check("visitors and members can't list recordings", rows(await as('anon', "select * from storage.objects where bucket_id = 'recordings'")).length === 0 && rows(await as(A, "select * from storage.objects where bucket_id = 'recordings'")).length === 0);
check('the team can', rows(await as(M, "select * from storage.objects where bucket_id = 'recordings'")).length === 1);
await as('anon', 'select public.consent_file_added($1, $2)', [sid, '1700000000000-story.mp3']);
await as('anon', 'select public.consent_file_added($1, $2)', [sid, '1700000000000-story.mp3']);
const files = rows(await as('admin', 'select files from public.speaker_consents where speaker_id = $1', [sid]))[0].files;
check('the form lists the recording once, with its size', files.length === 1 && files[0].name === '1700000000000-story.mp3' && Number(files[0].bytes) === 1000, files);
check("a file that didn't arrive isn't listed", !!(await fails_('anon', 'select public.consent_file_added($1, $2)', [sid, 'nope.mp3'])));
const sid10 = await send('anon', form);
for (let i = 0; i < 10; i++) await up('anon', `${sid10}/${i}.mp3`);
check('up to 10 files a form', !!(await fails_('anon', "insert into storage.objects (bucket_id, name) values ('recordings', $1)", [sid10 + '/10.mp3'])));
await as('admin', "update public.speaker_consents set created_at = now() - interval '2 days' where speaker_id = $1", [sid]);
check('no uploads a day after the form', !!(await fails_('anon', "insert into storage.objects (bucket_id, name) values ('recordings', $1)", [sid + '/late.mp3'])));
check("and the form can't be changed through it", !!(await fails_('anon', 'select public.consent_file_added($1, $2)', [sid, '1700000000000-story.mp3'])));
const sidW = await send('anon', form);
await as(M, 'update public.speaker_consents set withdrawn_at = now() where speaker_id = $1', [sidW]);
check('no uploads after withdrawing', !!(await fails_('anon', "insert into storage.objects (bucket_id, name) values ('recordings', $1)", [sidW + '/x.mp3'])));
check('the team can remove a recording', (await as(M, "delete from storage.objects where name = $1", [sid10 + '/0.mp3']), rows(await as('admin', 'select * from storage.objects where name = $1', [sid10 + '/0.mp3'])).length === 0));
const recent = rows(await as('admin', "select count(*)::int as n from public.speaker_consents where created_at > now() - interval '1 hour'"))[0].n;
await as('admin', `insert into public.speaker_consents (speaker_id, credit, access, language, age_range, video, understood, agreed)
  select public.new_speaker_id(), 'anonymous', 'private', 'flood', '18-29', 'no_video', true, true from generate_series(1, ${30 - recent})`);
await refuses({}, 'at most 30 forms an hour', 'last hour');
await as('admin', "delete from public.speaker_consents where language = 'flood'");

check('no notices without pg_net and a webhook', SID.test(await send('anon', form)));
await db.exec(`create schema net; create table net.sent (url text, body jsonb);
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
  language sql as $$ insert into net.sent values (url, body) returning 1::bigint $$;`);
await send('anon', form);
check('no notices without a webhook saved', rows(await as('admin', 'select * from net.sent')).length === 0);
await as('admin', "insert into public.app_settings (key, value) values ('discord_webhook', 'https://discord.com/api/webhooks/1/abc')");
check("the webhook can't be read through the API", !!(await fails_('anon', 'select * from public.app_settings')) && !!(await fails_(M, 'select * from public.app_settings')));
const sidN = await send('anon', { ...form, language: '@everyone Mazandarani' });
await up('anon', sidN + '/1-a.mp3', 3145728);
await as('anon', 'select public.consent_file_added($1, $2)', [sidN, '1-a.mp3']);
const sent = rows(await as('admin', 'select * from net.sent'));
check('the team gets a notice for the form and the recording, without names or emails', sent.length === 2 && sent[0].body.content.includes(sidN) && sent[0].body.content.includes('public access')
  && sent[1].body.content === `Recording received for ${sidN}: 1-a.mp3 (3.0 MB)` && !JSON.stringify(sent).includes('dino@example.com') && !JSON.stringify(sent).includes('Dino'), sent);
check('notices never ping anyone', sent.every(s => JSON.stringify(s.body.allowed_mentions) === '{"parse":[]}'));
check("visitors can't send notices", !!(await fails_('anon', "select public.notify_team('spam')")));
await db.exec(`create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint
  language plpgsql as $$ begin raise exception 'network down'; end $$;`);
check("a notice that fails doesn't stop the form", SID.test(await send('anon', form)));
await db.exec('drop schema net cascade');

// deleting an account
await as(B, `insert into public.resources (kind, lang, title, content) values ('text', 'fr', 'Le Corbeau', '{"text": "Maître Corbeau"}')`);
await as(B, 'select public.delete_my_account()');
check('deleting your account removes it and its resources', rows(await as('admin', 'select count(*)::int as n from public.resources where owner = $1', [B]))[0].n === 0 && rows(await as('admin', 'select count(*)::int as n from auth.users where id = $1', [B]))[0].n === 0);
check('deleting your account removes its reader data', rows(await as('admin', 'select count(*)::int as n from public.reader_docs where owner = $1', [B]))[0].n === 0);
check("signed-out visitors can't delete accounts", !!(await fails_('anon', 'select public.delete_my_account()')));

// deleting an account but keeping your posts and meanings, or deleting everything
const K = '00000000-0000-4000-8000-0000000000a1', X = '00000000-0000-4000-8000-0000000000a2';
await db.query("insert into auth.users (id, email) values ($1, 'keep@example.com'), ($2, 'all@example.com')", [K, X]);
const t = async (u, title) => rows(await as(u, "select public.forum_new_thread('general', $1, 'Hello') as id", [title]))[0].id;
const tx1 = await t(X, 'Only mine'), tx2 = await t(X, 'Mine with a reply'), tk = await t(K, 'Keep me');
await as(K, 'insert into public.forum_posts (thread, body) values ($1, $2)', [tx2, 'A reply from K']);
await as(X, 'insert into public.forum_posts (thread, body) values ($1, $2)', [tk, 'A reply from X']);
await as(K, "insert into public.glosses (lang, word_key, word, meaning) values ('mzn', 'kk', 'kk', 'kept meaning')");
await as(X, "insert into public.glosses (lang, word_key, word, meaning) values ('mzn', 'xx', 'xx', 'gone meaning')");
await as(K, 'select public.delete_my_account(true)');
const cnt = async (sql, args) => rows(await as("admin", sql, args))[0].n;
check('keeping contributions: the account and profile go', await cnt('select count(*)::int as n from auth.users where id = $1', [K]) === 0 && await cnt('select count(*)::int as n from public.profiles where id = $1', [K]) === 0);
check('keeping contributions: forum posts stay, under a former member', await cnt("select count(*)::int as n from public.forum_posts where body in ('A reply from K', 'Hello') and author is null and thread in ($1, $2)", [tx2, tk]) === 2
  && await cnt('select count(*)::int as n from public.forum_threads where id = $1 and author is null', [tk]) === 1);
check('keeping contributions: shared meanings stay', rows(await as('anon', "select * from public.gloss_suggestions('mzn', array['kk'])")).length === 1);
const xp = rows(await as('admin', "select id from public.forum_posts where body = 'A reply from X'"))[0].id;
await as(X, 'update public.forum_posts set deleted = true where id = $1', [xp]);
check("you can't mark a post deleted yourself", await cnt('select count(*)::int as n from public.forum_posts where id = $1 and not deleted', [xp]) === 1);
await as(X, 'select public.delete_my_account(false)');
check('deleting everything: your posts become [Content deleted]', await cnt("select count(*)::int as n from public.forum_posts where author is null and deleted and body = '[Content deleted]' and thread in ($1, $2, $3)", [tx1, tx2, tk]) === 3
  && await cnt("select count(*)::int as n from public.forum_posts where body in ('A reply from X')") === 0);
check('deleting everything: threads stay, with everyone else\'s posts', await cnt('select count(*)::int as n from public.forum_threads where id in ($1, $2, $3)', [tx1, tx2, tk]) === 3
  && await cnt("select count(*)::int as n from public.forum_posts where body = 'A reply from K'") === 1);
check('deleting everything: shared meanings go', rows(await as('anon', "select * from public.gloss_suggestions('mzn', array['xx'])")).length === 0);
check("signed-out visitors can't delete accounts either way", !!(await fails_('anon', 'select public.delete_my_account(true)')));

console.log(`\n${fails} failures`);
process.exit(fails ? 1 : 0);
