// llm-suggest: server-side Claude product suggestion proxy.
// Client posts { headline, team_id, source?, notes? } with the user's JWT.
// Function verifies team membership then calls Claude via platform ANTHROPIC_API_KEY.
//
// Deploy: supabase functions deploy llm-suggest
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callClaude } from "../_shared/claude.ts";
import { LLM_PROMPT, buildMessage } from "../_shared/llm.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
  const userId = userData.user.id;

  let payload: { headline?: string; team_id?: string; source?: string; notes?: string };
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { headline, team_id, source, notes } = payload;
  if (!headline || !team_id) return json({ error: "headline and team_id required" }, 400);

  // Verify team membership
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: membership } = await admin
    .from("team_members")
    .select("team_id")
    .eq("team_id", team_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) return json({ error: "Not a member of this team" }, 403);

  try {
    const message = buildMessage(headline, source, notes);
    const text = await callClaude(LLM_PROMPT, message);
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return json({ products: parsed.products || [] });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
