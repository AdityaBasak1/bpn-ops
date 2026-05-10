// Shared LLM prompt + message builder for bpn-ops edge functions.
// callLLM retained for backward compatibility but new code should use callClaude from claude.ts.

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
