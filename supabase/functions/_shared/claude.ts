// Shared Anthropic API caller for bpn-ops edge functions.
// Uses raw fetch (no SDK) for maximum Deno compatibility.
//
// Set secret: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  model = "claude-opus-4-7",
): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Anthropic ${r.status}: ${err.slice(0, 300)}`);
  }

  const data = await r.json();
  const block = (data.content || []).find((b: { type: string }) => b.type === "text");
  return block?.text ?? "";
}
