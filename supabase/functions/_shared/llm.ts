// Shared LLM prompts, tools, and helpers for bpn-ops edge functions.

// ── Agent mode (with Brave Search tool) ──────────────────────────────────────

export const SEARCH_TOOL = {
  name: "search_tiktok_shop",
  description: "Search the web to find real products available on TikTok Shop UK. Always use this before suggesting any product — do not guess product names.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query to find the product on TikTok Shop, e.g. 'PSG scarf TikTok Shop UK' or 'Arsenal badge pin set TikTok Shop'",
      },
    },
    required: ["query"],
  },
};

export const AGENT_PROMPT = `You are a TikTok Shop affiliate product expert for @thebluepodcastnetwork, a UK football podcast with 13K followers. Given a football moment, find exactly 3 REAL products on TikTok Shop UK that fans would impulse-buy.

YOU MUST use the search_tiktok_shop tool to verify every product before suggesting it. Do not guess product names.

PRODUCT SLOTS:
- Slot 1: Fan merchandise for the main club/player mentioned (scarf, hat, beanie, badge set, pin badges, pennant, mini kit, club drinkware, poster)
- Slot 2: Second fan merch or collectible (sticker album, trading cards, collectible figure, foam finger, keyring)
- Slot 3: Trending football TikTok product (EA FC video game, Panini sticker album, football LED night light, novelty gadget, mini table football)

SEARCH STRATEGY:
- Include "TikTok Shop UK" in every search query
- Use the club/player name from the headline (e.g. "Arsenal scarf TikTok Shop UK")
- Pick the most relevant real product from search results
- Price must be £5–£40

After searching all 3 products, return ONLY valid JSON — no markdown, no commentary:
{"products":[{"name":"exact product name from search results","search":"2-3 word TikTok search","category":"Apparel|Accessories|Collectibles|Books|Games|Home|Tech|Food|Fitness|Other","hook":"one punchy TikTok video angle sentence","price":15}]}`;

// ── Legacy prompt (used by scan-signals fallback) ─────────────────────────────

export const LLM_PROMPT = `You are a TikTok Shop affiliate expert for a UK football podcast (13K followers). Given a football moment, suggest exactly 3 products a fan would impulse-buy on TikTok Shop UK.

STEP 1 — Identify the clubs and players named in the headline.
STEP 2 — Your first 1-2 suggestions MUST be fan merchandise for those specific clubs/players: scarves, beanies, hats, badge sets, pin badges, sticker albums, mini kits, pennants, posters, collectible cards, foam fingers, club drinkware. These always sell to football fans.
STEP 3 — Your 3rd suggestion must be a trending or cool football-themed product on TikTok Shop UK right now: football video games (EA FC, Football Manager), novelty football gadgets, football-themed drinkware, keyrings, wall clocks, LED lights, trading card packs, mini table football sets, or any viral football product currently performing on TikTok. Think "what would a football fan impulse-buy while scrolling TikTok at midnight".

RULES:
- Exactly 3 products
- Must be buyable on TikTok Shop UK today (£5–£40)
- search: 2–3 plain words someone types into TikTok Shop (no punctuation, include club name or player name where relevant)
- hook: one punchy sentence — why fans will buy this RIGHT NOW
- NO print-on-demand, NO custom orders

Examples:
- "Mbappé misses training" → PSG scarf, PSG badge pin set, EA FC 25 video game
- "Arsenal beat PSG 2-0" → Arsenal FC scarf, Arsenal badge set, football trading card pack
- "VAR controversy in Man City match" → Man City beanie hat, Man City pennant, referee whistle set
- "Liverpool win the title" → Liverpool FC scarf, Liverpool badge pin set, football LED night light
- "Transfer rumour: Salah to PSG" → Liverpool FC scarf, PSG scarf, Panini Premier League sticker album

Return ONLY valid JSON, no markdown:
{"products":[{"name":"product name","search":"tiktok search keywords","category":"Apparel|Accessories|Collectibles|Books|Games|Home|Tech|Food|Fitness|Other","hook":"one sentence hook","price":20}]}`;

export type Product = {
  name: string;
  search: string;
  category: string;
  hook: string;
  price: number;
};

export function buildMessage(headline: string, source?: string, notes?: string): string {
  let msg = `Headline: ${headline}`;
  if (source) msg += `\nSource: ${source}`;
  if (notes) msg += ` | ${notes}`;
  return msg;
}

// ── Legacy multi-provider caller (kept for reference) ───────────────────────
export type Provider = "groq" | "openai" | "anthropic";

export async function callLLM(
  provider: Provider,
  apiKey: string,
  headline: string,
): Promise<{ products: Product[] | null; error: string | null }> {
  let url = "";
  let headers: Record<string, string> = {};
  let body = "";

  if (provider === "groq") {
    url = "https://api.groq.com/openai/v1/chat/completions";
    headers = { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey };
    body = JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: LLM_PROMPT },
        { role: "user", content: headline },
      ],
      temperature: 0.7,
      max_tokens: 600,
      response_format: { type: "json_object" },
    });
  } else if (provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    headers = { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey };
    body = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: LLM_PROMPT },
        { role: "user", content: headline },
      ],
      temperature: 0.7,
      max_tokens: 600,
      response_format: { type: "json_object" },
    });
  } else if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: LLM_PROMPT,
      messages: [{ role: "user", content: headline }],
    });
  } else {
    return { products: null, error: "Unknown provider: " + provider };
  }

  try {
    const r = await fetch(url, { method: "POST", headers, body });
    if (!r.ok) {
      const errText = await r.text();
      return { products: null, error: `${provider} ${r.status}: ${errText.slice(0, 200)}` };
    }
    const data = await r.json();
    const txt = provider === "anthropic" ? data.content[0].text : data.choices[0].message.content;
    const cleaned = txt.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return { products: parsed.products || null, error: null };
  } catch (e) {
    return { products: null, error: `${provider} fail: ${(e as Error).message}` };
  }
}
