# SA Flight Tracker

SA Flight Tracker shows reported aircraft positions across South African airspace, with airport reference data from OpenFlights. The map is powered by OpenStreetMap tiles and Leaflet.

## Data and refresh behavior

- Flight positions come from the OpenSky Network public API.
- The API server caches successful OpenSky results for five minutes to stay within the anonymous free quota. The interface polls the cached API more often to keep the screen responsive.
- OpenSky OAuth is optional. Add `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` as server-side Replit Secrets to use the higher authenticated quota.
- The server can read recent flight rows and South African airports from Supabase when `SUPABASE_URL` and `SUPABASE_ANON_KEY` are configured. If Supabase is not configured or does not have a recent snapshot, it uses the public OpenSky/OpenFlights sources and reports when it is falling back.
- OpenSky reports aircraft positions, not verified origin/destination flight plans. Do not interpret nearby aircraft or OpenFlights route records as confirmed arrivals or departures.

## Local development in Replit

The project uses the Replit-managed web and API workflows:

- Web app: `artifacts/sa-flight-tracker`
- API routes: `/api/flights`, `/api/flights/summary`, `/api/airports`, `/api/healthz`

The live map can run before a Supabase project is connected. Configure environment variables as Replit Secrets when you create the new Supabase project.

## Set up a new Supabase project

These files are provided for a new project. The existing Supabase projects were not changed.

1. Create a Supabase project.
2. Run `supabase/migrations/001_initial_schema.sql` in the Supabase SQL Editor.
3. Seed airports, airlines, and route reference data. From this folder, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the shell without committing them, then run:

   ```bash
   node scripts/seed-openflights.mjs
   ```

   The script downloads the OpenFlights data dumps, parses quoted CSV fields and `\N` nulls, and upserts in batches of 500. It can be rerun safely.

4. Install the Supabase CLI, link the new project, then deploy the functions:

   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase functions deploy refresh-flights
   supabase functions deploy cleanup-flights
   ```

5. Optional: provide OpenSky credentials to the Edge Function for the higher free quota:

   ```bash
   supabase secrets set OPENSKY_CLIENT_ID=<client-id> OPENSKY_CLIENT_SECRET=<client-secret>
   ```

   Without these values the function uses anonymous OpenSky access. Do not add any service-role value to the frontend.

6. Enable `pg_cron` and `pg_net` in the Supabase Dashboard under Database → Extensions. Add the project URL and service-role key to Supabase Vault, then run `supabase/schedule-example.sql` in the SQL Editor. The schedule calls `refresh-flights` every five minutes and removes stale rows every six hours.
7. In Replit Secrets, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` to let the API server read the new project's tables. The service-role key is needed only for the one-time seed script and remains on the server/Vault side.

The schedule uses Vault-backed secrets so credentials are not embedded in a committed SQL file. The two example `vault.create_secret` statements in `schedule-example.sql` are intentionally commented until you enter your new project's values.

## API overview

| Route | Purpose |
| --- | --- |
| `GET /api/flights` | Current live positions, freshness, stale flag, and any fallback warning |
| `GET /api/flights/summary` | Total, airborne, and on-ground counts |
| `GET /api/airports` | South African airport reference data |
| `GET /api/healthz` | API health check |

## Sources and attribution

- Flight data: [OpenSky Network](https://opensky-network.org/). Use is subject to OpenSky's terms and data-use policies.
- Airport, airline, and route reference data: [OpenFlights](https://openflights.org/data.php), licensed under ODbL.
- Map tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright), subject to the OpenStreetMap tile usage policy.
