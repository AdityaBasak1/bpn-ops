-- Phase 3: TikTok Shop API credentials stored server-side in team_secrets
-- App Key + App Secret from partner.tiktokshop.com
-- Access/refresh tokens stored after OAuth flow completes

ALTER TABLE team_secrets
  ADD COLUMN IF NOT EXISTS tiktok_app_key      TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_app_secret   TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_access_token  TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_token_expiry  BIGINT;

-- RPC: store TikTok app credentials (team creator only)
CREATE OR REPLACE FUNCTION set_team_tiktok_app(
  p_team_id   UUID,
  p_app_key   TEXT,
  p_app_secret TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM teams
    WHERE id = p_team_id AND created_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only the team creator can set TikTok credentials';
  END IF;

  INSERT INTO team_secrets (team_id, tiktok_app_key, tiktok_app_secret, updated_by)
  VALUES (p_team_id, p_app_key, p_app_secret, auth.uid())
  ON CONFLICT (team_id) DO UPDATE
    SET tiktok_app_key    = EXCLUDED.tiktok_app_key,
        tiktok_app_secret = EXCLUDED.tiktok_app_secret,
        updated_at        = now(),
        updated_by        = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION set_team_tiktok_app(UUID, TEXT, TEXT) TO authenticated;
