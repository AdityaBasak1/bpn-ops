// analyze-videos: Claude-powered video pattern analysis for the @thebluepodcastnetwork TikTok account.
// Loads all studio_snapshot rows for the team, builds a context prompt, calls Claude Sonnet 4.6,
// returns structured insights JSON, and caches the result as a bpn row (type=insight_run).
//
// Deploy: supabase functions deploy analyze-videos
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { INSIGHTS_PROMPT, buildInsightsContext } from "../_shared/insights.ts";
import { callClaude } from "../_shared/claude.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing authorization" }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Invalid session" }, 401);

  let payload: { team_id?: string };
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { team_id } = payload;
  if (!team_id) return json({ error: "team_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: membership } = await admin
    .from("team_members").select("team_id")
    .eq("team_id", team_id).eq("user_id", userData.user.id).maybeSingle();
  if (!membership) return json({ error: "Not a team member" }, 403);

  // Load all studio snapshots for this team
  const { data: rows } = await admin
    .from("bpn").select("payload")
    .eq("team_id", team_id).eq("type", "studio_snapshot");

  const snapshots: Record<string, unknown> = {};
  (rows || []).forEach((r: { payload: string }) => {
    try {
      const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
      const slot = ({
        content_top: "contentTop",
        daily_overview: "overview",
        daily_viewers: "viewers",
        follower_history: "history",
        follower_activity: "activity",
        follower_gender: "gender",
        follower_countries: "countries",
      } as Record<string, string>)[p.kind];
      if (slot) snapshots[slot] = p;
    } catch { /* skip malformed */ }
  });

  if (!snapshots.contentTop && !snapshots.overview) {
    return json({ error: "No TikTok Studio data found. Import CSVs first." }, 400);
  }

  try {
    const context = buildInsightsContext(snapshots);
    const text = await callClaude(INSIGHTS_PROMPT, context, "claude-sonnet-4-6");
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const insights = JSON.parse(cleaned);

    // Cache the result (upsert by item_id)
    const itemId = "latest-insights";
    const cacheRow = { id: itemId, kind: "insight_run", insights, generatedAt: new Date().toISOString(), ts: Date.now() };
    try { await admin.from("bpn").delete().eq("team_id", team_id).eq("type", "insight_run").eq("item_id", itemId); } catch { /* ignore */ }
    await admin.from("bpn").insert({
      team_id, type: "insight_run", item_id: itemId,
      payload: JSON.stringify(cacheRow), ts: Date.now(),
    });

    return json({ insights, generatedAt: cacheRow.generatedAt });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
