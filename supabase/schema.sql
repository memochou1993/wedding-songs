-- Song guide data lives in its own `song` schema, separate from the rest of the wedding project.
-- After running this, add `song` under Project Settings → Data API → Exposed schemas.
--
-- song.boards: one row per shared playlist board. The board id is a random string carried in
-- the page URL (?board=...). The page sends it in an `x-board-id` header, and RLS only exposes
-- the row whose id matches, so nobody can list or read other boards without knowing their id.

create schema if not exists song;
grant usage on schema song to anon, authenticated;

create table if not exists song.boards (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{16,64}$'),
  cols jsonb not null default '{}'::jsonb check (octet_length(cols::text) < 100000),
  updated_at timestamptz not null default now()
);

alter table song.boards enable row level security;

grant select, insert, update on song.boards to anon, authenticated;

create policy "read own board by header" on song.boards
  for select to anon, authenticated
  using (id = current_setting('request.headers', true)::json ->> 'x-board-id');

create policy "create own board by header" on song.boards
  for insert to anon, authenticated
  with check (id = current_setting('request.headers', true)::json ->> 'x-board-id');

create policy "update own board by header" on song.boards
  for update to anon, authenticated
  using (id = current_setting('request.headers', true)::json ->> 'x-board-id')
  with check (id = current_setting('request.headers', true)::json ->> 'x-board-id');
