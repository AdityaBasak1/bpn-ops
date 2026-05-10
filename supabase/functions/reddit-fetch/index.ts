// reddit-fetch (now ESPN-backed): server-side football news fetcher.
// Reddit blocks Supabase datacenter IPs, so we use ESPN's free public API instead.
// Returns signals in the app's Signal format, ready to display.
//
// Usage: GET /functions/v1/reddit-fetch (no params needed; fetches multiple leagues)
// Auth:  Anon key bearer token
//
// Deploy: supabase functions deploy reddit-fetch

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const LEAGUES = [
  { code: "eng.1",          label: "Premier League" },
  { code: "uefa.champions", label: "Champions League" },
  { code: "esp.1",          label: "La Liga" },
  { code: "eng.2",          label: "Championship" },
  { code: "uefa.europa",    label: "Europa League" },
  { code: "ger.1",          label: "Bundesliga" },
];

type Article = {
  headline?: string;
  description?: string;
  published?: string;
  links?: { web?: { href?: string } };
};

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
  products: null;
};

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

function velocityFromAge(ageH: number): number {
  if (ageH < 3) return 9;
  if (ageH < 6) return 8;
  if (ageH < 12) return 7;
  if (ageH < 24) return 6;
  if (ageH < 48) return 5;
  return 4;
}

function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 9);
}

async function fetchLeague(code: string, label: string): Promise<Signal[]> {
  try {
    const r = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/news?limit=10`,
    );
    if (!r.ok) return [];
    const d = await r.json();
    const arts: Article[] = d.articles || [];
    return arts.map((a) => {
      const headline = a.headline || "";
      const ts = a.published ? new Date(a.published).getTime() : Date.now();
      const ageH = Math.max(1, (Date.now() - ts) / 3600000);
      const v = velocityFromAge(ageH);
      return {
        id: uid("e-"),
        keyword: headline.length > 80 ? headline.slice(0, 77) + "..." : headline,
        fullTitle: headline,
        source: "ESPN " + label,
        velocity: v,
        notes: (a.description || "").slice(0, 120) + " · " + Math.round(ageH) + "h ago",
        url: a.links?.web?.href || "",
        category: guessCat(headline),
        ts,
        auto: true,
        products: null,
      };
    });
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  try {
    const results = await Promise.all(LEAGUES.map((l) => fetchLeague(l.code, l.label)));
    const all = results.flat();
    // Dedup by headline
    const seen = new Set<string>();
    const dedup = all.filter((s) => {
      const k = s.keyword.toLowerCase().slice(0, 30);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    dedup.sort((a, b) => b.ts - a.ts);
    return json({ signals: dedup.slice(0, 25) });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
