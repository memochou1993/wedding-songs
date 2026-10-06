// song-lookup: runs the wedding-song-screener workflow for custom songs, in the background.
//
// POST { queries: string[], songs?: { [query]: { title, artist } }, refresh?: string[] } with header x-board-id
//   → { results: { [query]: { status, output?, error?, refused?, kk? } } }
//
// status: running | done | failed | pending (board not saved yet, retry later) | limited (daily cap hit)
// refresh: queries (also listed in queries) to look up again, ignoring the cached result. A re-check counts
// toward the daily caps; over them, the old result comes back with refused: "limited".
// songs: the title and artist behind each query, which the workflow takes separately. A query without
// one (older pages) is sent as the title alone, and the workflow works out the artist.
// kk: the song's KKBOX track id, found once with the title and artist the workflow settled on. Its song page
// opens the KKBOX app on phones (a search page doesn't). Results looked up before this get it on their next poll.
// The browser calls this every few seconds while any of its custom songs is still running.
// A workflow execution keeps going on the platform even if nobody is polling; the next poll
// from any viewer of the board picks up the finished result. Results are cached per query in
// song.lookups, so a song is only looked up once across all boards.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const LFE_BASE = Deno.env.get("LFE_BASE") ?? "https://lfe-dev.rdc.headquarter.ai";
const LFE_APP_KEY = Deno.env.get("LFE_APP_KEY") ?? "";
const WORKFLOW_ID = "workflow-45212bf36e8d31a1";
const APP_GROUP = "wedding-song-app";

const ALLOWED_ORIGINS = new Set([
  "https://memochou1993.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
]);
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_QUERIES = 20;
const BOARD_DAILY_LIMIT = 30;
const GLOBAL_DAILY_LIMIT = 300;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  db: { schema: "song" },
  auth: { persistSession: false },
});

type Result = { status: string; output?: unknown; error?: string; refused?: string; kk?: string };
type Song = { title: string; artist: string };

const norm = (q: string) => q.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

// ---------- KKBOX track id ----------
const KK_CLIENT_ID = Deno.env.get("KKBOX_CLIENT_ID") ?? "";
const KK_CLIENT_SECRET = Deno.env.get("KKBOX_CLIENT_SECRET") ?? "";
let kkAuth: { token: string; until: number } | null = null;
let kkQueue: Promise<unknown> = Promise.resolve();  // one KKBOX lookup at a time, so a page full of songs doesn't burst the API

type Track = { name: string; url: string; album?: { artist?: { id: string; name: string } } };
// live, remixes, karaoke and the like: only used when nothing else matches
const ALT_VERSION = /\blive\b|remix|\bedit\b|acoustic|demo|re-?recorded|first take|karaoke|instrumental|music box|オルゴール|cover/i;
const bare = (x: string) => x.normalize("NFKC").toLowerCase().replace(/\b(feat|ft)\.?.*$/, "").replace(/[^\p{L}\p{N}]+/gu, "");
// "아이유（IU）" → ["아이유", "iu"]; "Aimyon[愛繆]" → ["aimyon", "愛繆"]; "Song - Live" → ["song"]
const names = (x = "") => {
  const s = x.normalize("NFKC"), out = [bare(s.replace(/[（(\[【][^）)\]】]*[）)\]】]/g, " ").replace(/\s+-\s+.*$/, ""))];
  for (const m of s.matchAll(/[（(\[【]([^）)\]】]*)[）)\]】]/g)) out.push(bare(m[1]));
  return out.filter((n) => n.length > 0);
};
const artistNames = (a = "") => a.split(/[／/&、,×]| x /).flatMap(names);

async function kkGet(type: "track" | "artist", q: string, limit: number) {
  if (!kkAuth || kkAuth.until < Date.now()) {
    const res = await fetch("https://account.kkbox.com/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: KK_CLIENT_ID, client_secret: KK_CLIENT_SECRET }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`kkbox token ${res.status}`);
    const t = await res.json();
    kkAuth = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
  }
  const u = new URL("https://api.kkbox.com/v1.1/search");
  u.search = new URLSearchParams({ q, type, territory: "TW", limit: String(limit) }).toString();
  const res = await fetch(u, { headers: { Authorization: `Bearer ${kkAuth.token}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`kkbox search ${res.status}`);
  return await res.json();
}

// the title and artist must both match; when the artist is spelled another way (あいみょん vs Aimyon[愛繆]),
// KKBOX's own artist search tells us which artist it is. Tries each way of naming the song in turn
// (the workflow's, then what was typed). Returns "" when nothing matches.
async function findKkbox(tries: Song[]): Promise<string> {
  const seen = new Set<string>();
  for (const { title, artist } of tries) {
    const k = norm(`${title}|${artist}`);
    if (!title || seen.has(k)) continue;
    seen.add(k);
    const id = await findKkboxAs(title, artist, tries.flatMap((t) => artistNames(t.artist)));
    if (id) return id;
  }
  return "";
}

async function findKkboxAs(title: string, artist: string, anyArtist: string[]): Promise<string> {
  const T = names(title), A = [...artistNames(artist), ...anyArtist];
  const titleOk = (t: Track) => names(t.name).some((y) => T.some((x) => y === x || (x.length >= 3 && y.startsWith(x))));
  const pick = (ts: Track[]) => ts.find((t) => !ALT_VERSION.test(t.name)) ?? ts[0];
  const main = artist.replace(/[（(][^）)]*[）)]/g, "").split(/[／/&、,×]/)[0].trim();
  const tracks: Track[] = (await kkGet("track", `${title} ${main}`.trim(), 15)).tracks?.data ?? [];
  let hit = pick(tracks.filter((t) => titleOk(t) && artistNames(t.album?.artist?.name).some((y) => A.some((x) => y.includes(x) || x.includes(y)))));
  if (!hit && main) {
    const ar = (await kkGet("artist", main, 1)).artists?.data?.[0];
    if (ar) hit = pick(tracks.filter((t) => titleOk(t) && t.album?.artist?.id === ar.id));
  }
  return hit ? hit.url.split("/song/")[1] ?? "" : "";
}

// the workflow's own title and artist are the corrected ones; a result it couldn't place falls back to what was asked
async function kkboxFor(key: string, output: unknown, asked: Song): Promise<string | undefined> {
  if (!KK_CLIENT_ID) return undefined;
  const o = (output ?? {}) as { song?: Song | null; songs?: Song[] };
  const s = o.song ?? o.songs?.[0] ?? asked;
  const run = kkQueue.then(() => findKkbox([{ title: s.title || asked.title, artist: s.artist || asked.artist }, asked]));
  kkQueue = run.catch(() => {});
  try {
    const id = await run;
    await db.from("lookups").update({ kkbox_id: id }).eq("query_norm", key);
    return id || undefined;
  } catch (e) {
    console.error("kkbox", key, e);  // left unset, so a later poll tries again
    return undefined;
  }
}
function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "content-type, x-board-id, apikey, authorization, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

async function lfe(path: string, body: unknown) {
  const res = await fetch(`${LFE_BASE}/${path}`, {
    method: "POST",
    headers: {
      "hq-application-api-key": LFE_APP_KEY,
      "hq-application-user": APP_GROUP,
      "hq-application-groups": APP_GROUP,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`lfe ${path} ${res.status} ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

async function countSince(col: string | null, value: string | null) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let q = db.from("lookups").select("query_norm", { count: "exact", head: true }).gte("created_at", since);
  if (col && value) q = q.eq(col, value);
  const { count } = await q;
  return count ?? 0;
}

async function overLimit(boardId: string) {
  return (await countSince("board_id", boardId)) >= BOARD_DAILY_LIMIT || (await countSince(null, null)) >= GLOBAL_DAILY_LIMIT;
}

async function start(query: string, key: string, boardId: string, song: Song): Promise<Result> {
  const { data: board } = await db.from("boards").select("id").eq("id", boardId).maybeSingle();
  if (!board) return { status: "pending" };
  if (await overLimit(boardId)) return { status: "limited" };

  const started = await lfe("runtime/start-execution", { workflow_id: WORKFLOW_ID, input: song });
  const { error } = await db.from("lookups").insert({
    query_norm: key, query, status: "running", execution_arn: started.execution_arn, board_id: boardId,
  });
  if (error) {
    // another viewer started the same query at the same moment; use theirs
    const { data } = await db.from("lookups").select("status, output, error").eq("query_norm", key).maybeSingle();
    return data ? { status: data.status, output: data.output ?? undefined, error: data.error ?? undefined } : { status: "running" };
  }
  return { status: "running" };
}

async function poll(key: string, arn: string, song: Song): Promise<Result> {
  const got = await lfe("runtime/get-execution", { execution_arn: arn, is_raw_included: false });
  const ex = got.execution ?? {};
  if (ex.status === "RUNNING") return { status: "running" };
  if (ex.status === "SUCCEEDED") {
    await db.from("lookups").update({ status: "done", output: ex.output, updated_at: new Date().toISOString() }).eq("query_norm", key);
    return { status: "done", output: ex.output, kk: await kkboxFor(key, ex.output, song) };
  }
  const msg = [ex.status, ex.error, ex.cause].filter(Boolean).join(": ").slice(0, 500) || "unknown";
  await db.from("lookups").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("query_norm", key);
  return { status: "failed", error: "查詢失敗" };
}

// re-check: run the workflow again over the cached row; created_at moves to now so it counts toward today's caps
async function restart(query: string, key: string, boardId: string, song: Song, old: Result): Promise<Result> {
  if (await overLimit(boardId)) return { ...old, refused: "limited" };
  try {
    const started = await lfe("runtime/start-execution", { workflow_id: WORKFLOW_ID, input: song });
    const now = new Date().toISOString();
    const { error } = await db.from("lookups").update({
      query, status: "running", execution_arn: started.execution_arn, output: null, error: null, kkbox_id: null,
      board_id: boardId, created_at: now, updated_at: now,
    }).eq("query_norm", key);
    if (error) throw new Error(`update ${error.message}`);
    return { status: "running" };
  } catch (e) {
    // keep the old result rather than pretend it is running
    console.error("restart", query, e);
    return { ...old, refused: "error" };
  }
}

async function handle(query: string, boardId: string, refresh: boolean, song: Song): Promise<Result> {
  const key = norm(query);
  const { data: row } = await db.from("lookups").select("status, execution_arn, output, kkbox_id").eq("query_norm", key).maybeSingle();
  if (!row) return await start(query, key, boardId, song);
  if (refresh && row.status !== "running") {
    return await restart(query, key, boardId, song, row.status === "done" ? { status: "done", output: row.output } : { status: "failed", error: "查詢失敗" });
  }
  if (row.status === "done") {
    const kk = row.kkbox_id === null ? await kkboxFor(key, row.output, song) : row.kkbox_id || undefined;
    return { status: "done", output: row.output, kk };
  }
  if (row.status === "failed") return { status: "failed", error: "查詢失敗" };
  return row.execution_arn ? await poll(key, row.execution_arn, song) : { status: "running" };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return json({ error: "origin not allowed" }, 403);
  const boardId = req.headers.get("x-board-id") ?? "";
  if (!ID_RE.test(boardId)) return json({ error: "missing board id" }, 400);
  if (!LFE_APP_KEY) return json({ error: "server not configured" }, 500);

  let body: { queries?: unknown; refresh?: unknown; songs?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const queries = Array.isArray(body.queries)
    ? [...new Set(body.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0 && q.length <= 200))].slice(0, MAX_QUERIES)
    : [];
  const given = body.songs && typeof body.songs === "object" ? body.songs as Record<string, unknown> : {};
  const songOf = (q: string): Song => {
    const v = given[q] as { title?: unknown; artist?: unknown } | undefined;
    const title = typeof v?.title === "string" ? v.title.trim().slice(0, 200) : "";
    const artist = typeof v?.artist === "string" ? v.artist.trim().slice(0, 200) : "";
    return title ? { title, artist } : { title: q.trim(), artist: "" };
  };
  const refresh = new Set(Array.isArray(body.refresh) ? body.refresh.filter((q): q is string => typeof q === "string") : []);

  const results: Record<string, Result> = {};
  await Promise.all(queries.map(async (q) => {
    try { results[q] = await handle(q, boardId, refresh.has(q), songOf(q)); }
    catch (e) { console.error("lookup", q, e); results[q] = { status: "running" }; }
  }));
  return json({ results });
});
