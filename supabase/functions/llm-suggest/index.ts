// llm-suggest: server-side LLM proxy that uses the team's stored key.
// Client posts { headline, team_id } with the user's JWT.
// Function verifies membership, looks up team_secrets, calls the provider.
//
// Deploy: supabase functions deploy llm-suggest

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, type Provider } from "../_shared/llm.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing authorization" }, 401);
  }

  // Verify the user via their JWT
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Invalid session" }, 401);
  }
  const userId = userData.user.id;

  let payload: { headline?: string; team_id?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { headline, team_id } = payload;
  if (!headline || !team_id) {
    return json({ error: "headline and team_id required" }, 400);
  }

  // Service-role client to bypass RLS for membership check + secret read
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: membership } = await admin
    .from("team_members")
    .select("team_id")
    .eq("team_id", team_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) {
    return json({ error: "Not a member of this team" }, 403);
  }

  const { data: secret } = await admin
    .from("team_secrets")
    .select("llm_key, llm_provider")
    .eq("team_id", team_id)
    .maybeSingle();
  if (!secret?.llm_key) {
    return json({ error: "No LLM key set for this team" }, 400);
  }

  const provider = (secret.llm_provider || "groq") as Provider;
  const { products, error } = await callLLM(provider, secret.llm_key, headline);
  if (error) return json({ error }, 502);
  return json({ products });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
