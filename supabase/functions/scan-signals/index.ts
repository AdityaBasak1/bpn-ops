// scan-signals: on-demand Reddit scanner + Claude enricher.
// Fetches hot football posts, scores by velocity, enriches top signals with Claude.
//
// Trigger: Client "Scan Now" button (user's JWT) or pg_cron (service-role, currently disabled).
//
// Deploy: supabase functions deploy scan-signals
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
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const authHeader = req.headers.get("Authorization") || "";
  const isServiceRole = authHeader.includes(SUPABASE_SERVICE_ROLE_KEY);

  let teamIds: string[] = [];
  if (isServiceRole) {
    // Cron path: scan all teams
    const { data } = await admin.from("teams").select("id");
    teamIds = (data || []).map((r) => r.id);
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

  const signals = await fetchAllReddit();
  if (signals.length === 0) {
    return json({ ok: true, scanned_teams: 0, message: "Reddit fetch returned nothing" });
  }

  let totalWritten = 0;
  const errors: string[] = [];

  for (const teamId of teamIds) {
    const teamSignals: Signal[] = signals.map((s) => ({ ...s, products: null }));

    // Enrich top signals with Claude
    const top = teamSignals.filter((s) => s.velocity >= 6).slice(0, 5);
    if (top.length > 0) {
      const results = await Promise.all(
        top.map(async (sig) => {
          try {
            const text = await callClaude(LLM_PROMPT, buildMessage(sig.fullTitle, sig.source, sig.notes));
            const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
            const parsed = JSON.parse(cleaned);
            return { id: sig.id, products: parsed.products || null };
          } catch (e) {
            errors.push(`team ${teamId}: ${(e as Error).message}`);
            return { id: sig.id, products: null };
          }
        }),
      );
      results.forEach(({ id, products }) => {
        if (products) {
          const idx = teamSignals.findIndex((s) => s.id === id);
          if (idx >= 0) teamSignals[idx].products = products;
        }
      });
    }

    // Upsert signals into bpn table
    const rows = teamSignals.map((s) => ({
      team_id: teamId,
      type: "auto_signal",
      item_id: s.id,
      payload: JSON.stringify(s),
      ts: s.ts,
    }));

    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    await admin.from("bpn").delete()
      .eq("team_id", teamId).eq("type", "auto_signal").lt("ts", cutoff);

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
    status, headers: { ...CORS, "Content-Type": "application/json" },
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
          id: string; title: string; ups: number;
          num_comments: number; created_utc: number; permalink: string;
        };
        const ageH = Math.max(1, (Date.now() / 1000 - p.created_utc) / 3600);
        const v = Math.min(10, Math.round(Math.log2(1 + (p.ups + p.num_comments * 3) / ageH)));
        return {
          id: "a-" + p.id,
          keyword: p.title.length > 80 ? p.title.slice(0, 77) + "..." : p.title,
          fullTitle: p.title,
          source: "Reddit r/" + sub,
          velocity: v,
          notes: `${p.num_comments} comments · ${p.ups} upvotes · ${Math.round(ageH)}h ago`,
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
