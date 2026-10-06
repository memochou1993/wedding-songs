-- song.lookups: cached AI lookups (wedding-song-screener workflow) for custom songs.
-- One row per normalized query, shared by every board so a song is only looked up once.
-- Only the song-lookup Edge Function (service role) touches this table; browsers never read it directly.

create table if not exists song.lookups (
  query_norm text primary key,
  query text not null,
  status text not null check (status in ('running', 'done', 'failed')),
  execution_arn text,
  output jsonb,
  error text,
  board_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lookups_board_created on song.lookups (board_id, created_at);

alter table song.lookups enable row level security;
-- no policies: anon/authenticated get nothing; the Edge Function uses the service role.

grant usage on schema song to service_role;
grant select, insert, update, delete on song.lookups to service_role;
grant select on song.boards to service_role;
