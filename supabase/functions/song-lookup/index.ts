// song-lookup: runs the wedding-song-screener workflow for custom songs, in the background.
//
// POST { queries: string[] } with header x-board-id
//   → { results: { [query]: { status, output?, error? } } }
//
// status: running | done | failed | pending (board not saved yet, retry later) | limited (daily cap hit)
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

type Result = { status: string; output?: unknown; error?: string };

const norm = (q: string) => q.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

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
  if (!res.ok) throw new Error(`lfe ${path} ${res.status}`);
  return await res.json();
}

async function countSince(col: string | null, value: string | null) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let q = db.from("lookups").select("query_norm", { count: "exact", head: true }).gte("created_at", since);
  if (col && value) q = q.eq(col, value);
  const { count } = await q;
  return count ?? 0;
}

async function start(query: string, key: string, boardId: string): Promise<Result> {
  const { data: board } = await db.from("boards").select("id").eq("id", boardId).maybeSingle();
  if (!board) return { status: "pending" };
  if ((await countSince("board_id", boardId)) >= BOARD_DAILY_LIMIT) return { status: "limited" };
  if ((await countSince(null, null)) >= GLOBAL_DAILY_LIMIT) return { status: "limited" };

  const started = await lfe("runtime/start-execution", { workflow_id: WORKFLOW_ID, input: { query } });
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

async function poll(key: string, arn: string): Promise<Result> {
  const got = await lfe("runtime/get-execution", { execution_arn: arn, is_raw_included: false });
  const ex = got.execution ?? {};
  if (ex.status === "RUNNING") return { status: "running" };
  if (ex.status === "SUCCEEDED") {
    await db.from("lookups").update({ status: "done", output: ex.output, updated_at: new Date().toISOString() }).eq("query_norm", key);
    return { status: "done", output: ex.output };
  }
  const msg = [ex.status, ex.error, ex.cause].filter(Boolean).join(": ").slice(0, 500) || "unknown";
  await db.from("lookups").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("query_norm", key);
  return { status: "failed", error: "查詢失敗" };
}

async function handle(query: string, boardId: string): Promise<Result> {
  const key = norm(query);
  const { data: row } = await db.from("lookups").select("status, execution_arn, output").eq("query_norm", key).maybeSingle();
  if (!row) return await start(query, key, boardId);
  if (row.status === "done") return { status: "done", output: row.output };
  if (row.status === "failed") return { status: "failed", error: "查詢失敗" };
  return row.execution_arn ? await poll(key, row.execution_arn) : { status: "running" };
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

  let body: { queries?: unknown };
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const queries = Array.isArray(body.queries)
    ? [...new Set(body.queries.filter((q): q is string => typeof q === "string" && q.trim().length > 0 && q.length <= 200))].slice(0, MAX_QUERIES)
    : [];

  const results: Record<string, Result> = {};
  await Promise.all(queries.map(async (q) => {
    try { results[q] = await handle(q, boardId); }
    catch (e) { console.error("lookup", q, e); results[q] = { status: "running" }; }
  }));
  return json({ results });
});
