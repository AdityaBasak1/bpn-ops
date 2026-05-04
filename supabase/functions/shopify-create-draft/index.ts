// shopify-create-draft: creates a draft product in the team's Shopify store.
// Credentials (domain + access token) are stored server-side in team_secrets.
//
// Client posts { team_id, product: { title, body_html, vendor, product_type, tags, variants } }
// with the user's JWT in Authorization header.
//
// Deploy: supabase functions deploy shopify-create-draft

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL             = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY        = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHOPIFY_API_VERSION      = "2024-01";

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

  let payload: { team_id?: string; product?: Record<string, unknown> };
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const { team_id, product } = payload;
  if (!team_id || !product) return json({ error: "team_id and product required" }, 400);

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
  const shopifyUrl =
    `https://${shopify_domain}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/products.json`;

  // Create the product as a draft
  const shopifyBody = {
    product: {
      ...product,
      status: "draft",
    },
  };

  const shopifyRes = await fetch(shopifyUrl, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": shopify_token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(shopifyBody),
  });

  const shopifyData = await shopifyRes.json();

  if (!shopifyRes.ok) {
    const errMsg = shopifyData?.errors
      ? JSON.stringify(shopifyData.errors)
      : `Shopify API error ${shopifyRes.status}`;
    return json({ error: errMsg }, 502);
  }

  const created = shopifyData.product;
  return json({
    product_id: created.id,
    title: created.title,
    admin_url: `https://admin.shopify.com/store/${shopify_domain}/products/${created.id}`,
    status: created.status,
  });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
