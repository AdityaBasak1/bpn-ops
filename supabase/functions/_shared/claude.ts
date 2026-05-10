// Shared Anthropic Claude helper for bpn-ops edge functions.
// Uses prompt caching on the system prompt (~90% cost reduction on repeated calls).
//
// Usage:
//   import { callClaude } from "../_shared/claude.ts";
//   const text = await callClaude(SYSTEM_PROMPT, userMessage);
//
// Set secret: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.39.0";

const client = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
});

export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  model = "claude-opus-4-7",
): Promise<string> {
  const stream = client.messages.stream({
    model,
    max_tokens: 1024,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: systemPrompt,
        // Cache the system prompt — saves ~90% on repeated calls with the same prompt
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });

  const msg = await stream.finalMessage();
  const block = msg.content.find((b) => b.type === "text");
  return block?.type === "text" ? block.text : "";
}
