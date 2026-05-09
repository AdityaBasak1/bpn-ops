-- Phase 4: TikTok creator OAuth tokens (from developers.tiktok.com)
-- Separate from TikTok Shop API credentials (phase3)

ALTER TABLE team_secrets
  ADD COLUMN IF NOT EXISTS tiktok_client_key      TEXT,
  ADD COLUMN IF NOT EXISTS tiktok_client_secret   TEXT,
  ADD COLUMN IF NOT EXISTS creator_access_token   TEXT,
  ADD COLUMN IF NOT EXISTS creator_refresh_token  TEXT,
  ADD COLUMN IF NOT EXISTS creator_token_expiry   BIGINT,
  ADD COLUMN IF NOT EXISTS creator_open_id        TEXT;

CREATE OR REPLACE FUNCTION set_team_tiktok_creator_app(
  p_team_id      UUID,
  p_client_key   TEXT,
  p_client_secret TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM teams WHERE id = p_team_id AND created_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only the team creator can set TikTok credentials';
  END IF;

  INSERT INTO team_secrets (team_id, tiktok_client_key, tiktok_client_secret, updated_by)
  VALUES (p_team_id, p_client_key, p_client_secret, auth.uid())
  ON CONFLICT (team_id) DO UPDATE
    SET tiktok_client_key    = EXCLUDED.tiktok_client_key,
        tiktok_client_secret = EXCLUDED.tiktok_client_secret,
        updated_at           = now(),
        updated_by           = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION set_team_tiktok_creator_app(UUID, TEXT, TEXT) TO authenticated;
