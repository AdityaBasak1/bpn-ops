// Shared LLM caller used by both `llm-suggest` and `scan-signals` Edge Functions.
// Mirrors the logic of suggestProducts() in bpn-ops/index.html, but server-side.

export const LLM_PROMPT = `You are a TikTok Shop affiliate expert for a UK football podcast. Given a football moment headline, suggest exactly 3 real products available on TikTok Shop UK that viewers would buy BECAUSE OF THIS SPECIFIC MOMENT.

RULES:
- Products must be directly triggered by this specific moment — not generic football items
- Must realistically exist on TikTok Shop UK right now (fan merch, accessories, collectibles, lifestyle goods)
- Strong video hook: the product + this moment must make a compelling, obvious TikTok
- Price £5–£40 (TikTok Shop impulse-buy sweet spot)
- search: 2-3 plain keywords someone would type into TikTok Shop to find this exact product (no punctuation, no brand names unless very well known)
- NO custom print-on-demand, NO made-to-order, NO Amazon-exclusive products

Examples by moment type:
- Referee/VAR controversy → referee whistle set, red card novelty item, referee kit costume
- Star player scores → that club scarf, mini football goal net, player wall poster
- Promotion/relegation → celebration flag set, foam stadium finger, football confetti cannon
- Injury news → sports recovery foam roller, reusable ice pack set, physio resistance bands
- Transfer rumour → mystery football shirt box, club badge pin set, football sticker album

Return ONLY valid JSON, no markdown, no commentary:
{"products":[{"name":"specific product name","search":"tiktok search keywords","category":"Apparel|Accessories|Collectibles|Books|Games|Home|Tech|Food|Fitness|Other","desc":"one sentence: why this product + this exact moment makes a compelling TikTok","price":20}]}`;

export type Provider = "groq" | "openai" | "anthropic";

export type Product = {
  name: string;
  search: string;
  category: string;
  desc: string;
  price: number;
};

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
