// scan-signals: cron-fired (and on-demand) Reddit scanner + LLM enricher.
// Writes auto_signal rows to the `bpn` table, one batch per team that has a
// configured LLM key. Reddit is fetched once per invocation and reused.
//
// Trigger sources:
//   1. pg_cron via net.http_post (every 30 min) — uses service-role auth header.
//   2. Client "Scan Now" button — uses the user's JWT; only that user's team is scanned.
//
// Deploy: supabase functions deploy scan-signals

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

const SUBS = [
  { name: "soccer", limit: 15 },
  { name: "PremierLeague", limit: 10 },
  { name: "EFL", limit: 8 },
];

type Signal = {
  id: string;
  keyword: string;
  fullTitle: string;
  source: string;
  velocity: number;
  notes: string;
  url: string;
  category: string;
  ts: number;
  auto: boolean;
  products: unknown[] | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const authHeader = req.headers.get("Authorization") || "";
  const isServiceRole = authHeader.includes(SUPABASE_SERVICE_ROLE_KEY);

  // Determine target teams: cron run = all teams with keys; user run = caller's team(s) only.
  let teamIds: string[] = [];
  if (isServiceRole) {
    const { data } = await admin
      .from("team_secrets")
      .select("team_id, llm_key")
      .not("llm_key", "is", null);
    teamIds = (data || []).filter((r) => r.llm_key).map((r) => r.team_id);
  } else {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) return json({ error: "Invalid session" }, 401);
    const { data: memberships } = await admin
      .from("team_members")
      .select("team_id")
      .eq("user_id", userData.user.id);
    teamIds = (memberships || []).map((m) => m.team_id);
  }

  if (teamIds.length === 0) {
    return json({ ok: true, scanned_teams: 0, message: "No teams to scan" });
  }

  // Fetch Reddit once for the entire invocation.
  const signals = await fetchAllReddit();
  if (signals.length === 0) {
    return json({ ok: true, scanned_teams: 0, message: "Reddit fetch returned nothing" });
  }

  let totalWritten = 0;
  const errors: string[] = [];

  for (const teamId of teamIds) {
    const { data: secret } = await admin
      .from("team_secrets")
      .select("llm_key, llm_provider")
      .eq("team_id", teamId)
      .maybeSingle();

    // Clone signals so per-team enrichment doesn't bleed across teams.
    const teamSignals: Signal[] = signals.map((s) => ({ ...s, products: null }));

    if (secret?.llm_key) {
      const provider = (secret.llm_provider || "groq") as Provider;
      const top = teamSignals.filter((s) => s.velocity >= 6).slice(0, 5);
      const results = await Promise.all(
        top.map(async (sig) => {
          const { products, error } = await callLLM(provider, secret.llm_key!, sig.fullTitle);
          if (error) errors.push(`team ${teamId}: ${error}`);
          return { id: sig.id, products };
        }),
      );
      results.forEach(({ id, products }) => {
        if (products) {
          const idx = teamSignals.findIndex((s) => s.id === id);
          if (idx >= 0) teamSignals[idx].products = products;
        }
      });
    }

    // Upsert as auto_signal rows in the bpn table. item_id ensures dedupe per team.
    const rows = teamSignals.map((s) => ({
      team_id: teamId,
      type: "auto_signal",
      item_id: s.id,
      payload: JSON.stringify(s),
      ts: s.ts,
    }));

    // Delete previous auto_signal rows for this team older than 48h, then insert.
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    await admin.from("bpn").delete()
      .eq("team_id", teamId).eq("type", "auto_signal").lt("ts", cutoff);

    // Upsert one-by-one to avoid duplicate-key errors (no composite unique).
    for (const row of rows) {
      const { data: existing } = await admin
        .from("bpn")
        .select("id")
        .eq("team_id", teamId)
        .eq("type", "auto_signal")
        .eq("item_id", row.item_id)
        .maybeSingle();
      if (existing) {
        await admin.from("bpn").update({ payload: row.payload, ts: row.ts }).eq("id", existing.id);
      } else {
        await admin.from("bpn").insert(row);
      }
      totalWritten++;
    }
  }

  return json({ ok: true, scanned_teams: teamIds.length, signals_written: totalWritten, errors });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function guessCat(t: string): string {
  t = t.toLowerCase();
  if (/kit|jersey|shirt|wear/.test(t)) return "Apparel";
  if (/poster|art|print|photo/.test(t)) return "Art/Prints";
  if (/scarf|hat|flag|badge/.test(t)) return "Accessories";
  return "";
}

async function fetchSub(sub: string, limit: number): Promise<Signal[]> {
  try {
    const r = await fetch(
      `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}&raw_json=1`,
      { headers: { "User-Agent": "BlueDropShop/1.0" } },
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.data?.children || [])
      .filter((c: { data: { stickied?: boolean } }) => !c.data.stickied)
      .map((c: { data: Record<string, unknown> }) => {
        const p = c.data as {
          id: string;
          title: string;
          ups: number;
          num_comments: number;
          created_utc: number;
          permalink: string;
        };
        const ageH = Math.max(1, (Date.now() / 1000 - p.created_utc) / 3600);
        const v = Math.min(10, Math.round(Math.log2(1 + (p.ups + p.num_comments * 3) / ageH)));
        return {
          id: "a-" + p.id,
          keyword: p.title.length > 80 ? p.title.slice(0, 77) + "..." : p.title,
          fullTitle: p.title,
          source: "Reddit r/" + sub,
          velocity: v,
          notes: `${p.num_comments} comments - ${p.ups} upvotes - ${Math.round(ageH)}h ago`,
          url: "https://reddit.com" + p.permalink,
          category: guessCat(p.title),
          ts: p.created_utc * 1000,
          auto: true,
          products: null,
        } as Signal;
      });
  } catch {
    return [];
  }
}

async function fetchAllReddit(): Promise<Signal[]> {
  const results = await Promise.all(SUBS.map((s) => fetchSub(s.name, s.limit)));
  const all = results.flat();
  const seen = new Set<string>();
  const dedup = all.filter((s) => {
    const k = s.keyword.toLowerCase().slice(0, 30);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  dedup.sort((a, b) => b.velocity - a.velocity);
  return dedup.slice(0, 20);
}
