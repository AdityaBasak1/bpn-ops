-- Phase 2: Shopify credentials stored server-side in team_secrets
-- The edge functions shopify-create-draft and shopify-sync-orders
-- read shopify_domain and shopify_token via service role.
-- Only the team creator can write them via set_team_shopify_secret().

ALTER TABLE team_secrets
  ADD COLUMN IF NOT EXISTS shopify_domain TEXT,
  ADD COLUMN IF NOT EXISTS shopify_token  TEXT;

-- RPC: store Shopify credentials (team creator only)
CREATE OR REPLACE FUNCTION set_team_shopify_secret(
  p_team_id UUID,
  p_domain  TEXT,
  p_token   TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only the team creator may set credentials
  IF NOT EXISTS (
    SELECT 1 FROM teams
    WHERE id = p_team_id AND created_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only the team creator can set Shopify credentials';
  END IF;

  INSERT INTO team_secrets (team_id, shopify_domain, shopify_token, updated_by)
  VALUES (p_team_id, p_domain, p_token, auth.uid())
  ON CONFLICT (team_id) DO UPDATE
    SET shopify_domain = EXCLUDED.shopify_domain,
        shopify_token  = EXCLUDED.shopify_token,
        updated_at     = now(),
        updated_by     = auth.uid();
END;
$$;

-- RPC: check whether Shopify is configured (any team member can call)
CREATE OR REPLACE FUNCTION get_team_shopify_status(p_team_id UUID)
RETURNS TABLE(has_shopify BOOLEAN, shopify_domain TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    (ts.shopify_token IS NOT NULL AND ts.shopify_token <> ''),
    ts.shopify_domain
  FROM team_secrets ts
  WHERE ts.team_id = p_team_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false::BOOLEAN, NULL::TEXT;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION set_team_shopify_secret(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_team_shopify_status(UUID)              TO authenticated;
