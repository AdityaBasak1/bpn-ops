// shopify-sync-orders: fetches recent orders from the team's Shopify store.
// Credentials (domain + access token) are stored server-side in team_secrets.
//
// Client posts { team_id } with the user's JWT in Authorization header.
// Returns { orders: [{ id, total_price, created_at, line_items: [{ title, quantity, price }] }] }
//
// Deploy: supabase functions deploy shopify-sync-orders

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPIFY_API_VERSION       = "2024-01";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing authorization" }, 401);

  // Verify user JWT
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Invalid session" }, 401);
  const userId = userData.user.id;

  let payload: { team_id?: string };
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const { team_id } = payload;
  if (!team_id) return json({ error: "team_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Verify team membership
  const { data: membership } = await admin
    .from("team_members")
    .select("team_id")
    .eq("team_id", team_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!membership) return json({ error: "Not a member of this team" }, 403);

  // Fetch Shopify credentials
  const { data: secret } = await admin
    .from("team_secrets")
    .select("shopify_domain, shopify_token")
    .eq("team_id", team_id)
    .maybeSingle();

  if (!secret?.shopify_token || !secret?.shopify_domain) {
    return json({
      error: "Shopify not configured for this team. Add your Access Token in Settings.",
    }, 400);
  }

  const { shopify_domain, shopify_token } = secret;

  // Fetch orders updated in the last 30 days, limit 100
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const shopifyUrl =
    `https://${shopify_domain}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/orders.json` +
    `?status=any&limit=100&updated_at_min=${encodeURIComponent(since)}`;

  const shopifyRes = await fetch(shopifyUrl, {
    headers: {
      "X-Shopify-Access-Token": shopify_token,
      "Content-Type": "application/json",
    },
  });

  const shopifyData = await shopifyRes.json();

  if (!shopifyRes.ok) {
    const errMsg = shopifyData?.errors
      ? JSON.stringify(shopifyData.errors)
      : `Shopify API error ${shopifyRes.status}`;
    return json({ error: errMsg }, 502);
  }

  // Return only the fields the client needs (line_items for matching to drops)
  const orders = (shopifyData.orders ?? []).map((o: Record<string, unknown>) => ({
    id: o.id,
    total_price: o.total_price,
    created_at: o.created_at,
    financial_status: o.financial_status,
    line_items: ((o.line_items as Record<string, unknown>[]) ?? []).map((li) => ({
      title: li.title,
      quantity: li.quantity,
      price: li.price,
    })),
  }));

  return json({ orders, synced_at: new Date().toISOString() });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
