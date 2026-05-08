// tiktok-auth-callback: OAuth 2.0 callback handler for TikTok Shop Partner API.
// TikTok redirects here after the user authorises the app.
// Exchanges the auth code for access + refresh tokens and stores in team_secrets.
//
// Redirect URI set in partner.tiktokshop.com must match:
// https://{project}.supabase.co/functions/v1/tiktok-auth-callback
//
// Deploy: supabase functions deploy tiktok-auth-callback

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TIKTOK_TOKEN_URL          = "https://open.tiktokapis.com/v2/oauth/token/";
const APP_REDIRECT              = "https://adityabasak1.github.io/bpn-ops/";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code      = url.searchParams.get("code");
  const teamId    = url.searchParams.get("state"); // we pass team_id as state
  const errParam  = url.searchParams.get("error");

  if (errParam) {
    return redirect(APP_REDIRECT + "?tiktok_error=" + encodeURIComponent(errParam));
  }
  if (!code || !teamId) {
    return redirect(APP_REDIRECT + "?tiktok_error=missing_params");
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Fetch the team's app credentials
  const { data: secret } = await admin
    .from("team_secrets")
    .select("tiktok_app_key, tiktok_app_secret")
    .eq("team_id", teamId)
    .maybeSingle();

  if (!secret?.tiktok_app_key || !secret?.tiktok_app_secret) {
    return redirect(APP_REDIRECT + "?tiktok_error=no_app_credentials");
  }

  // Exchange auth code for tokens (creator OAuth — open.tiktokapis.com)
  const redirectUri = `${SUPABASE_URL}/functions/v1/tiktok-auth-callback`;
  const body = new URLSearchParams({
    client_key:    secret.tiktok_app_key,
    client_secret: secret.tiktok_app_secret,
    code:          code,
    grant_type:    "authorization_code",
    redirect_uri:  redirectUri,
  });

  const tokenRes = await fetch(TIKTOK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    return redirect(
      APP_REDIRECT + "?tiktok_error=" + encodeURIComponent(tokenData.error_description || tokenData.error || "token_exchange_failed")
    );
  }

  const { access_token, refresh_token, expires_in } = tokenData;
  const expiry = Date.now() + ((expires_in || 86400) * 1000);

  // Store tokens in team_secrets
  await admin
    .from("team_secrets")
    .update({
      tiktok_access_token:  access_token,
      tiktok_refresh_token: refresh_token,
      tiktok_token_expiry:  expiry,
      updated_at:           new Date().toISOString(),
    })
    .eq("team_id", teamId);

  return redirect(APP_REDIRECT + "?tiktok_connected=1");
});

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}
