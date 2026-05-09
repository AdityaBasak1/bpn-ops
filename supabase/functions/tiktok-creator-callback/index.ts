// tiktok-creator-callback: OAuth callback for general TikTok creator auth
// Uses developers.tiktok.com credentials (Client Key / Client Secret)
// Exchanges auth code for creator access + refresh tokens, stores in team_secrets
//
// Redirect URI registered at developers.tiktok.com must be:
// https://{project}.supabase.co/functions/v1/tiktok-creator-callback
//
// Deploy: supabase functions deploy tiktok-creator-callback

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN_URL                 = "https://open.tiktokapis.com/v2/oauth/token/";
const APP_REDIRECT              = "https://adityabasak1.github.io/bpn-ops/";

Deno.serve(async (req) => {
  const url    = new URL(req.url);
  const code   = url.searchParams.get("code");
  const teamId = url.searchParams.get("state");
  const err    = url.searchParams.get("error");

  if (err) return redirect(APP_REDIRECT + "?creator_error=" + encodeURIComponent(err));
  if (!code || !teamId) return redirect(APP_REDIRECT + "?creator_error=missing_params");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: secret } = await admin
    .from("team_secrets")
    .select("tiktok_client_key, tiktok_client_secret")
    .eq("team_id", teamId)
    .maybeSingle();

  if (!secret?.tiktok_client_key || !secret?.tiktok_client_secret) {
    return redirect(APP_REDIRECT + "?creator_error=no_creator_credentials");
  }

  const redirectUri = `${SUPABASE_URL}/functions/v1/tiktok-creator-callback`;

  const body = new URLSearchParams({
    client_key:    secret.tiktok_client_key,
    client_secret: secret.tiktok_client_secret,
    code,
    grant_type:    "authorization_code",
    redirect_uri:  redirectUri,
  });

  const tokenRes  = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });

  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    return redirect(
      APP_REDIRECT + "?creator_error=" +
      encodeURIComponent(tokenData.error_description || tokenData.error)
    );
  }

  const { access_token, refresh_token, expires_in, open_id } = tokenData;
  const expiry = Date.now() + ((expires_in || 86400) * 1000);

  await admin.from("team_secrets").update({
    creator_access_token:  access_token,
    creator_refresh_token: refresh_token,
    creator_token_expiry:  expiry,
    creator_open_id:       open_id,
    updated_at:            new Date().toISOString(),
  }).eq("team_id", teamId);

  return redirect(APP_REDIRECT + "?creator_connected=1");
});

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}
