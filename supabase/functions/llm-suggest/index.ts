// llm-suggest: Claude agent that searches Brave to find real TikTok Shop products.
// Agent loop: Claude calls search_tiktok_shop tool → Brave Search returns real listings
// → Claude picks real product names → returns 3 verified products.
//
// Secrets needed:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase secrets set BRAVE_SEARCH_KEY=BSA...
//
// Deploy: supabase functions deploy llm-suggest

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AGENT_PROMPT, SEARCH_TOOL, buildMessage, LLM_PROMPT } from "../_shared/llm.ts";
import { callClaude } from "../_shared/claude.ts";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY             = Deno.env.get("ANTHROPIC_API_KEY")!;
const BRAVE_KEY                 = Deno.env.get("BRAVE_SEARCH_KEY") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Brave Search ──────────────────────────────────────────────────────────────

async function searchBrave(query: string): Promise<string> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&country=GB&search_lang=en`;
  try {
    const r = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": BRAVE_KEY,
      },
    });
    if (!r.ok) return `Search failed (${r.status})`;
    const data = await r.json();
    const results = (data.web?.results || []).slice(0, 5);
    if (!results.length) return "No results found for this query.";
    return results
      .map((r: { title: string; url: string; description?: string }, i: number) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || ""}`
      )
      .join("\n\n");
  } catch (e) {
    return `Search error: ${(e as Error).message}`;
  }
}

// ── Claude agent loop ─────────────────────────────────────────────────────────

type Message = { role: string; content: string | unknown[] };

async function runAgentLoop(userMessage: string): Promise<string> {
  const messages: Message[] = [{ role: "user", content: userMessage }];

  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        tools: [SEARCH_TOOL],
        system: AGENT_PROMPT,
        messages,
      }),
    });

    if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
    const data = await r.json();

    if (data.stop_reason === "end_turn") {
      const textBlock = (data.content as Array<{ type: string; text?: string }>)
        .find((b) => b.type === "text");
      return textBlock?.text ?? "";
    }

    if (data.stop_reason === "tool_use") {
      // Append Claude's response (including tool_use blocks)
      messages.push({ role: "assistant", content: data.content });

      // Execute all tool calls in parallel
      const toolUseBlocks = (data.content as Array<{ type: string; id: string; input: { query: string } }>)
        .filter((b) => b.type === "tool_use");

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: await searchBrave(block.input.query),
        }))
      );

      messages.push({ role: "user", content: toolResults });
    } else {
      // Unexpected stop reason — return whatever text we have
      const textBlock = (data.content as Array<{ type: string; text?: string }>)
        .find((b) => b.type === "text");
      return textBlock?.text ?? "";
    }
  }

  throw new Error("Agent loop hit max iterations");
}

// ── Edge function handler ─────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing authorization" }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Invalid session" }, 401);

  let payload: { headline?: string; team_id?: string; source?: string; notes?: string };
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { headline, team_id, source, notes } = payload;
  if (!headline || !team_id) return json({ error: "headline and team_id required" }, 400);

  // Verify team membership
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: membership } = await admin
    .from("team_members").select("team_id")
    .eq("team_id", team_id).eq("user_id", userData.user.id).maybeSingle();
  if (!membership) return json({ error: "Not a member of this team" }, 403);

  try {
    const message = buildMessage(headline, source, notes);
    let text: string;

    if (BRAVE_KEY) {
      // Agent mode: Claude searches Brave to find real products
      text = await runAgentLoop(message);
    } else {
      // Fallback: Claude suggests without web search
      text = await callClaude(LLM_PROMPT, message, "claude-haiku-4-5-20251001");
    }

    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return json({ products: parsed.products || [] });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
