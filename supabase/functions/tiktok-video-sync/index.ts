// tiktok-video-sync: pulls video analytics from TikTok Display API
// and updates matching post records in the bpn table.
//
// Matches posts by TikTok video ID found in the stored videoUrl.
// Updates payload with: views, likes, comments, shares, tiktok_synced_at
//
// Deploy: supabase functions deploy tiktok-video-sync

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const VIDEO_LIST_URL = "https://open.tiktokapis.com/v2/video/list/";
const VIDEO_FIELDS   = "id,title,create_time,view_count,like_count,comment_count,share_count,duration,cover_image_url,share_url";

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

  // Verify calling user
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Invalid session" }, 401);

  let payload: { team_id?: string };
  try { payload = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { team_id } = payload;
  if (!team_id) return json({ error: "team_id required" }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Get creator tokens
  const { data: secret } = await admin
    .from("team_secrets")
    .select("creator_access_token, creator_token_expiry, creator_refresh_token, tiktok_client_key, tiktok_client_secret")
    .eq("team_id", team_id)
    .maybeSingle();

  if (!secret?.creator_access_token) {
    return json({ error: "TikTok creator account not connected. Connect in Settings." }, 400);
  }

  // Refresh token if expired
  let accessToken = secret.creator_access_token;
  if (secret.creator_token_expiry && Date.now() > secret.creator_token_expiry - 300_000) {
    const refreshBody = new URLSearchParams({
      client_key:    secret.tiktok_client_key,
      client_secret: secret.tiktok_client_secret,
      grant_type:    "refresh_token",
      refresh_token: secret.creator_refresh_token,
    });
    const refreshRes  = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody.toString(),
    });
    const refreshData = await refreshRes.json();
    if (!refreshData.error && refreshData.access_token) {
      accessToken = refreshData.access_token;
      await admin.from("team_secrets").update({
        creator_access_token:  refreshData.access_token,
        creator_refresh_token: refreshData.refresh_token || secret.creator_refresh_token,
        creator_token_expiry:  Date.now() + ((refreshData.expires_in || 86400) * 1000),
      }).eq("team_id", team_id);
    }
  }

  // Fetch latest 20 videos from TikTok
  const videoRes = await fetch(`${VIDEO_LIST_URL}?fields=${VIDEO_FIELDS}`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ max_count: 20 }),
  });

  const videoData = await videoRes.json();

  if (videoData.error?.code && videoData.error.code !== "ok") {
    return json({ error: videoData.error.message || "TikTok API error" }, 502);
  }

  const videos: Array<{
    id: string; title: string; view_count: number;
    like_count: number; comment_count: number; share_count: number;
    share_url: string; cover_image_url: string; create_time: number;
  }> = videoData.data?.videos || [];

  if (!videos.length) {
    return json({ synced: 0, message: "No videos found on this account" });
  }

  // Fetch existing posts for this team
  const { data: posts } = await admin
    .from("bpn")
    .select("id, payload")
    .eq("team_id", team_id)
    .eq("type", "content");

  let synced = 0;
  const now = new Date().toISOString();

  for (const video of videos) {
    // Match post by TikTok video URL or ID in the videoUrl field
    const matchingPost = posts?.find(p => {
      const url = p.payload?.videoUrl || "";
      return url.includes(video.id) || url.includes(video.share_url);
    });

    if (matchingPost) {
      await admin.from("bpn").update({
        payload: {
          ...matchingPost.payload,
          views:            video.view_count,
          likes:            video.like_count,
          comments:         video.comment_count,
          shares:           video.share_count,
          coverUrl:         video.cover_image_url,
          tiktok_synced_at: now,
        },
      }).eq("id", matchingPost.id);
      synced++;
    }
  }

  // Store the full video list for display (as a special bpn record)
  const videoSummary = videos.map(v => ({
    id: v.id, title: v.title,
    views: v.view_count, likes: v.like_count,
    comments: v.comment_count, shares: v.share_count,
    url: v.share_url, cover: v.cover_image_url,
    ts: v.create_time * 1000,
  }));

  return json({
    synced,
    total_videos: videos.length,
    videos: videoSummary,
    last_sync: now,
  });
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}
