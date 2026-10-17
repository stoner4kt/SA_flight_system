-- Travel-agency booking and ground-transfer schema.
-- The Flight Tracker's original 001_initial_schema.sql remains unchanged.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.fn_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- PII encryption keys are configured per Supabase database. Never store a key
-- in this migration or expose these functions to browser roles.
CREATE OR REPLACE FUNCTION public.popia_encrypt(input_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  encryption_key TEXT := current_setting('app.popia_aes_key', TRUE);
BEGIN
  IF input_value IS NULL OR input_value = '' THEN
    RETURN NULL;
  END IF;
  IF encryption_key IS NULL OR length(encryption_key) < 32 THEN
    RAISE EXCEPTION 'POPIA_ENCRYPTION_NOT_CONFIGURED';
  END IF;
  RETURN encode(
    pgp_sym_encrypt(input_value, encryption_key, 'cipher-algo=aes256, compress-algo=0'),
    'base64'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.popia_decrypt(input_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  encryption_key TEXT := current_setting('app.popia_aes_key', TRUE);
BEGIN
  IF input_value IS NULL OR input_value = '' THEN
    RETURN NULL;
  END IF;
  IF encryption_key IS NULL OR length(encryption_key) < 32 THEN
    RAISE EXCEPTION 'POPIA_ENCRYPTION_NOT_CONFIGURED';
  END IF;
  RETURN pgp_sym_decrypt(decode(input_value, 'base64'), encryption_key);
END;
$$;

REVOKE ALL ON FUNCTION public.popia_encrypt(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.popia_decrypt(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.popia_encrypt(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.popia_decrypt(TEXT) TO service_role;

CREATE SEQUENCE IF NOT EXISTS public.itinerary_ref_seq;

CREATE TABLE IF NOT EXISTS public.itineraries (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  itinerary_ref TEXT NOT NULL UNIQUE DEFAULT (
    'SA-' || to_char(NOW() AT TIME ZONE 'Africa/Johannesburg', 'YYMMDD') || '-' ||
    lpad(nextval('public.itinerary_ref_seq')::TEXT, 5, '0')
  ),
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  phone_enc TEXT,
  passport_enc TEXT,
  sa_id_enc TEXT,
  flight_data JSONB NOT NULL DEFAULT '{"segments":[]}'::JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_itineraries_email
  ON public.itineraries (lower(client_email));
CREATE INDEX IF NOT EXISTS idx_itineraries_status_created
  ON public.itineraries (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.fleet_vehicles (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  registration TEXT NOT NULL UNIQUE,
  make_model TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.fleet_assignments (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  itinerary_id UUID NOT NULL REFERENCES public.itineraries(id) ON DELETE CASCADE,
  vehicle_id UUID NOT NULL REFERENCES public.fleet_vehicles(id),
  driver_name TEXT NOT NULL,
  driver_contact_enc TEXT,
  pickup_at TIMESTAMPTZ NOT NULL,
  dropoff_at TIMESTAMPTZ NOT NULL,
  pickup_address TEXT NOT NULL,
  dropoff_address TEXT NOT NULL,
  tracking_state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (tracking_state IN (
      'scheduled', 'en_route', 'arrived', 'passenger_onboard', 'completed', 'cancelled'
    )),
  notification_owner TEXT NOT NULL DEFAULT 'edge'
    CHECK (notification_owner IN ('api', 'edge')),
  notes TEXT,
  assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fleet_assignment_valid_window CHECK (dropoff_at > pickup_at),
  CONSTRAINT fleet_vehicle_no_overlap
    EXCLUDE USING gist (
      vehicle_id WITH =,
      tstzrange(pickup_at, dropoff_at, '[)') WITH &&
    )
    WHERE (tracking_state <> 'cancelled')
);

CREATE INDEX IF NOT EXISTS idx_fleet_assignments_itinerary
  ON public.fleet_assignments (itinerary_id, pickup_at);
CREATE INDEX IF NOT EXISTS idx_fleet_assignments_vehicle_window
  ON public.fleet_assignments (vehicle_id, pickup_at, dropoff_at)
  WHERE tracking_state <> 'cancelled';
CREATE INDEX IF NOT EXISTS idx_fleet_assignments_state_updated
  ON public.fleet_assignments (tracking_state, updated_at DESC);

DROP TRIGGER IF EXISTS trg_itineraries_updated_at ON public.itineraries;
CREATE TRIGGER trg_itineraries_updated_at
  BEFORE UPDATE ON public.itineraries
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_fleet_vehicles_updated_at ON public.fleet_vehicles;
CREATE TRIGGER trg_fleet_vehicles_updated_at
  BEFORE UPDATE ON public.fleet_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_fleet_assignments_updated_at ON public.fleet_assignments;
CREATE TRIGGER trg_fleet_assignments_updated_at
  BEFORE UPDATE ON public.fleet_assignments
  FOR EACH ROW EXECUTE FUNCTION public.fn_touch_updated_at();

ALTER TABLE public.itineraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fleet_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_agents_manage_itineraries" ON public.itineraries;
CREATE POLICY "authenticated_agents_manage_itineraries"
  ON public.itineraries FOR ALL TO authenticated
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "authenticated_agents_read_vehicles" ON public.fleet_vehicles;
CREATE POLICY "authenticated_agents_read_vehicles"
  ON public.fleet_vehicles FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS "authenticated_agents_manage_vehicles" ON public.fleet_vehicles;
CREATE POLICY "authenticated_agents_manage_vehicles"
  ON public.fleet_vehicles FOR ALL TO authenticated
  USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS "authenticated_agents_manage_assignments" ON public.fleet_assignments;
CREATE POLICY "authenticated_agents_manage_assignments"
  ON public.fleet_assignments FOR ALL TO authenticated
  USING (TRUE) WITH CHECK (TRUE);

REVOKE ALL ON public.itineraries, public.fleet_vehicles, public.fleet_assignments FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.itineraries, public.fleet_vehicles, public.fleet_assignments TO authenticated;
GRANT ALL ON public.itineraries, public.fleet_vehicles, public.fleet_assignments TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.itinerary_ref_seq TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'fleet_assignments'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.fleet_assignments;
  END IF;
END;
$$;
