// Shared LLM caller used by both `llm-suggest` and `scan-signals` Edge Functions.
// Mirrors the logic of suggestProducts() in bpn-ops/index.html, but server-side.

export const LLM_PROMPT = `You are a TikTok Shop affiliate product strategist for a football-focused creator account. Given a football news headline, suggest 3-5 REAL EXISTING product categories that you can find on TikTok Shop or Amazon UK to tag in a TikTok video capitalising on this moment.

CRITICAL RULES:
- Suggest REAL PRODUCT TYPES THAT ALREADY EXIST on TikTok Shop / Amazon (e.g. "LED football-shaped night light", "Liverpool FC scarf", "Football Manager 2026 game", "Panini Premier League stickers 2026")
- NOT custom designs, NOT print-on-demand, NOT things you'd make yourself
- Mix of football-specific (fan merch, books, games) AND loosely-related products that fit the moment (e.g. "kitchen gadget" for a cooking-related player meme, "mens grooming kit" for a footballer known for style)
- Products must be broadly available: jerseys, scarves, books, video games, collectibles, posters, drinkware, electronics, home goods, fitness gear, snacks
- Use SEARCH-FRIENDLY keywords — plain nouns, no quotes or apostrophes, no punctuation
- Price range £5-£60 (TikTok Shop sweet spot)

Return ONLY valid JSON in this exact format, no markdown, no commentary:
{"products":[{"name":"short product name","search":"2-4 plain keywords for search","category":"Apparel|Accessories|Collectibles|Books|Games|Home|Tech|Food|Fitness|Other","desc":"1-sentence angle for the TikTok video hook","price":25}]}`;

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
