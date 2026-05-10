// Shared LLM prompt + message builder for bpn-ops edge functions.
// callLLM retained for backward compatibility but new code should use callClaude from claude.ts.

export const LLM_PROMPT = `You are a TikTok Shop affiliate product expert for a UK football podcast account (@thebluepodcastnetwork, 13K followers). Given a football moment, suggest exactly 3 real products available on TikTok Shop UK right now.

RULES — no exceptions:
- Exactly 3 products
- Must exist on TikTok Shop UK today (fan merch, accessories, collectibles, fitness, home, tech, food, games, books)
- Triggered by THIS specific moment — not generic football items
- Price £5–£40 (TikTok Shop impulse-buy range)
- search: 2–3 plain keywords a viewer would type into TikTok Shop (no punctuation, no brand names unless very well known)
- hook: one punchy sentence — the TikTok video angle that makes this product irresistible right now
- NO print-on-demand, NO custom orders, NO Amazon-only products

Examples by moment type:
- Referee/VAR controversy → referee whistle set, red card novelty item, referee kit costume
- Star player scores → club scarf, mini goal net, player poster
- Promotion/relegation → celebration flag, foam stadium finger, confetti cannon
- Injury news → foam roller, reusable ice pack, resistance bands
- Transfer rumour → mystery shirt box, club badge pin set, sticker album

Return ONLY valid JSON, no markdown, no commentary:
{"products":[{"name":"product name","search":"tiktok keywords","category":"Apparel|Accessories|Collectibles|Books|Games|Home|Tech|Food|Fitness|Other","hook":"video angle sentence","price":20}]}`;

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
