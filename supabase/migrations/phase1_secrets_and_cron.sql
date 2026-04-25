-- Phase 1: team-shared LLM secret + scheduled scan
-- Run AFTER SETUP.sql. Paste into Supabase SQL Editor.
--
-- Prereqs (one-time, do these first via Database → Extensions):
--   1. Enable extension: pg_cron
--   2. Enable extension: pg_net
--   3. Enable extension: supabase_vault   (for storing service-role key)

-- ─── Step 1: secrets table ──────────────────────────────────────────────
-- Holds the team's LLM key. NO client SELECT policy — only Edge Functions
-- (using service_role) read this. Clients use the helper RPCs below.
CREATE TABLE IF NOT EXISTS team_secrets (
  team_id UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  llm_key TEXT,
  llm_provider TEXT NOT NULL DEFAULT 'groq',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

ALTER TABLE team_secrets ENABLE ROW LEVEL SECURITY;
-- Intentionally NO SELECT/INSERT/UPDATE policies for clients.
-- All client access is via SECURITY DEFINER functions below.

-- ─── Step 2: helper RPCs for clients ────────────────────────────────────
-- Set/replace the team's LLM key. Only the team creator can call this.
CREATE OR REPLACE FUNCTION set_team_llm_secret(
  p_team_id UUID,
  p_key TEXT,
  p_provider TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM teams WHERE id = p_team_id AND created_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only the team creator can set the LLM key';
  END IF;

  IF p_provider NOT IN ('groq','openai','anthropic') THEN
    RAISE EXCEPTION 'Invalid provider: %', p_provider;
  END IF;

  INSERT INTO team_secrets (team_id, llm_key, llm_provider, updated_at, updated_by)
  VALUES (p_team_id, p_key, p_provider, NOW(), auth.uid())
  ON CONFLICT (team_id) DO UPDATE
    SET llm_key = EXCLUDED.llm_key,
        llm_provider = EXCLUDED.llm_provider,
        updated_at = NOW(),
        updated_by = auth.uid();
END;
$$;

-- Returns whether a key is set, and which provider — for UI display.
-- Never returns the key itself. Any team member can call.
CREATE OR REPLACE FUNCTION get_team_llm_status(p_team_id UUID)
RETURNS TABLE (has_key BOOLEAN, provider TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM team_members WHERE team_id = p_team_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this team';
  END IF;

  RETURN QUERY
    SELECT (s.llm_key IS NOT NULL AND s.llm_key <> '') AS has_key,
           COALESCE(s.llm_provider,'groq') AS provider
    FROM team_secrets s
    WHERE s.team_id = p_team_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'groq'::TEXT;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION set_team_llm_secret(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_team_llm_status(UUID) TO authenticated;

-- ─── Step 3: auto_signal type uses existing bpn table ───────────────────
-- No schema change needed — bpn already accepts arbitrary 'type' values.
-- The scan-signals Edge Function writes rows with type='auto_signal',
-- one row per team that has an LLM key configured.
-- Existing RLS on bpn already restricts reads to team members.

-- ─── Step 4: store project URL + service-role key in vault ──────────────
-- Run these ONCE, replacing the placeholder values, BEFORE scheduling cron.
-- (Find both in Supabase Dashboard → Project Settings → API)
--
SELECT vault.create_secret('https://sdgdznaagzgwpbihakyx.supabase.co', 'project_url');
SELECT vault.create_secret('YOUR-SERVICE-ROLE-KEY', 'service_role_key');
--
-- If you've already set these for another purpose, skip this step.

-- ─── Step 5: pg_cron schedule ───────────────────────────────────────────
-- Fires every 30 minutes. Calls the scan-signals Edge Function which
-- iterates teams with keys, fetches Reddit, enriches, writes auto_signal rows.
SELECT cron.schedule(
  'bluedrop-scan-signals',
  '*/30 * * * *',
  $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/scan-signals',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);

-- To unschedule: SELECT cron.unschedule('bluedrop-scan-signals');
-- To inspect:    SELECT * FROM cron.job;
-- To see runs:   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
