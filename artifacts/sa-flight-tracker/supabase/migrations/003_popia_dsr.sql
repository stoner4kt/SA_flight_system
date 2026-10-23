-- Data-subject request workflow.
-- This is 003 because 001_initial_schema.sql already belongs to the flight app
-- and 002_fleet_and_popia.sql supplies the CRM tables and shared trigger.

CREATE TABLE IF NOT EXISTS public.popia_dsr_requests (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  request_type TEXT NOT NULL
    CHECK (request_type IN ('access', 'erasure', 'correction', 'objection')),
  subject_email TEXT NOT NULL,
  subject_name TEXT,
  verify_token TEXT,
  token_expires_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'processing', 'completed', 'rejected')),
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_popia_dsr_token
  ON public.popia_dsr_requests (verify_token);
CREATE INDEX IF NOT EXISTS idx_popia_dsr_email
  ON public.popia_dsr_requests (lower(subject_email));
CREATE INDEX IF NOT EXISTS idx_popia_dsr_status
  ON public.popia_dsr_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_popia_dsr_expiry
  ON public.popia_dsr_requests (token_expires_at)
  WHERE status = 'pending';

COMMENT ON COLUMN public.popia_dsr_requests.verify_token IS
  'SHA-256 hash of a one-time 256-bit verification token; the raw token is never stored.';

CREATE TABLE IF NOT EXISTS public.popia_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_popia_rate_limits_expiry
  ON public.popia_rate_limits (expires_at);

ALTER TABLE public.popia_dsr_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.popia_rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_agents_manage_dsr" ON public.popia_dsr_requests;
CREATE POLICY "authenticated_agents_manage_dsr"
  ON public.popia_dsr_requests FOR ALL TO authenticated
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "block_anon_dsr" ON public.popia_dsr_requests;
CREATE POLICY "block_anon_dsr"
  ON public.popia_dsr_requests FOR ALL TO anon
  USING (FALSE) WITH CHECK (FALSE);

DROP TRIGGER IF EXISTS trg_popia_dsr_updated_at ON public.popia_dsr_requests;
CREATE TRIGGER trg_popia_dsr_updated_at
  BEFORE UPDATE ON public.popia_dsr_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

ALTER TABLE public.itineraries ADD COLUMN IF NOT EXISTS client_email TEXT;
CREATE INDEX IF NOT EXISTS idx_itineraries_client_email
  ON public.itineraries (lower(client_email));

REVOKE ALL ON public.popia_dsr_requests FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.popia_dsr_requests TO authenticated;
GRANT ALL ON public.popia_dsr_requests TO service_role;
REVOKE ALL ON public.popia_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.popia_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.popia_consume_rate_limit(
  p_key_hash TEXT,
  p_max_requests INTEGER,
  p_window_seconds INTEGER
)
RETURNS TABLE(allowed BOOLEAN, retry_after_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_row public.popia_rate_limits%ROWTYPE;
  now_at TIMESTAMPTZ := NOW();
  window_length INTERVAL;
BEGIN
  IF p_max_requests < 1 OR p_window_seconds < 1 OR length(p_key_hash) <> 64 THEN
    RAISE EXCEPTION 'INVALID_RATE_LIMIT_ARGUMENTS';
  END IF;
  window_length := make_interval(secs => p_window_seconds);

  INSERT INTO public.popia_rate_limits AS limits (
    key_hash, window_started_at, request_count, expires_at
  ) VALUES (
    p_key_hash, now_at, 1, now_at + window_length
  )
  ON CONFLICT (key_hash) DO UPDATE
  SET window_started_at = CASE
        WHEN limits.window_started_at + window_length <= now_at THEN now_at
        ELSE limits.window_started_at
      END,
      request_count = CASE
        WHEN limits.window_started_at + window_length <= now_at THEN 1
        ELSE limits.request_count + 1
      END,
      expires_at = CASE
        WHEN limits.window_started_at + window_length <= now_at THEN now_at + window_length
        ELSE limits.expires_at
      END
  RETURNING * INTO current_row;

  RETURN QUERY SELECT
    current_row.request_count <= p_max_requests,
    GREATEST(1, CEIL(EXTRACT(EPOCH FROM (current_row.window_started_at + window_length - now_at)))::INTEGER);
END;
$$;

REVOKE ALL ON FUNCTION public.popia_consume_rate_limit(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.popia_consume_rate_limit(TEXT, INTEGER, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.popia_complete_erasure(
  request_id UUID,
  agent_id UUID,
  agent_notes TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  request_row public.popia_dsr_requests%ROWTYPE;
  redacted_count INTEGER := 0;
  audit_line TEXT;
BEGIN
  SELECT * INTO request_row
  FROM public.popia_dsr_requests
  WHERE id = request_id
  FOR UPDATE;

  IF NOT FOUND OR request_row.request_type <> 'erasure' THEN
    RAISE EXCEPTION 'DSR_ERASURE_REQUEST_NOT_FOUND';
  END IF;
  IF request_row.verified_at IS NULL THEN
    RAISE EXCEPTION 'DSR_REQUEST_NOT_VERIFIED';
  END IF;

  UPDATE public.itineraries
  SET client_name = 'REDACTED',
      phone_enc = NULL,
      passport_enc = NULL,
      sa_id_enc = NULL,
      flight_data = NULL,
      status = 'cancelled'
  WHERE lower(client_email) = lower(request_row.subject_email);
  GET DIAGNOSTICS redacted_count = ROW_COUNT;

  audit_line := 'ERASURE completed at ' || to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    || '; redacted itinerary records: ' || redacted_count::TEXT
    || '; completed by agent: ' || COALESCE(agent_id::TEXT, 'unknown');
  IF agent_notes IS NOT NULL AND length(trim(agent_notes)) > 0 THEN
    audit_line := audit_line || '; agent note: ' || trim(agent_notes);
  END IF;

  UPDATE public.popia_dsr_requests
  SET status = 'completed',
      completed_at = NOW(),
      completed_by = agent_id,
      notes = concat_ws(E'\n', NULLIF(notes, ''), audit_line)
  WHERE id = request_id;

  RETURN redacted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.popia_complete_erasure(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.popia_complete_erasure(UUID, UUID, TEXT) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'popia_dsr_requests'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.popia_dsr_requests;
  END IF;
END;
$$;
