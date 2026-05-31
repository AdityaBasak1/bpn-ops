// Shared Anthropic API caller for bpn-ops edge functions.
// Uses raw fetch (no SDK) for maximum Deno compatibility.
//
// Set secret: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  model = "claude-opus-4-7",
  maxTokens = 1024,
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
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      stream: true,
    }),
  });

  if (!r.ok || !r.body) {
    const err = await r.text().catch(() => "");
    throw new Error(`Anthropic ${r.status}: ${err.slice(0, 300)}`);
  }

  // Parse the SSE stream, accumulating text deltas. Streaming keeps the
  // connection active during long (e.g. 365-day) generations that would
  // otherwise risk an idle drop on a single blocking request.
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // keep the trailing partial line for the next chunk
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let evt: { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
      try { evt = JSON.parse(payload); } catch { continue; } // skip keep-alive / partial lines
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        text += evt.delta.text ?? "";
      } else if (evt.type === "error") {
        throw new Error(`Anthropic stream error: ${evt.error?.message || "unknown"}`);
      }
    }
  }
  return text;
}
