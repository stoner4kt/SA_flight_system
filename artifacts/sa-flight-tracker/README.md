# SA Travel Agency Workspace

SA Travel is one staff workspace for customer flight bookings, airport transfers, vehicle assignments, POPIA data-subject requests, and live aircraft positions across Southern African airspace. The flight map is an operational reference, not a confirmed flight-plan service.

## Data and refresh behavior

- Flight positions come from the OpenSky Network public API.
- The API server caches successful OpenSky results for five minutes to stay within the anonymous free quota. The interface polls the cached API more often to keep the screen responsive.
- OpenSky OAuth is optional. Add `OPENSKY_CLIENT_ID` and `OPENSKY_CLIENT_SECRET` as server-side Replit Secrets to use the higher authenticated quota.
- Flight and CRM API routes require a valid Supabase staff session. `/api/healthz`, the public privacy-request submission, and email verification routes are public.
- Live flight data uses the OpenSky source and cached snapshots; airport reference records come from OpenFlights. CRM records are stored in the new Supabase project configured for this app.
- OpenSky reports aircraft positions, not verified origin/destination flight plans. Do not interpret nearby aircraft or OpenFlights route records as confirmed arrivals or departures.

## Local development in Replit

The project uses the Replit-managed web and API workflows. The CRM and flight tools are pages in the same app and use one Supabase login:

- Web app: `artifacts/sa-flight-tracker`
- API routes: `/api/dashboard/summary`, `/api/itineraries`, `/api/fleet/*`, `/api/popia/*`, `/api/flights`, `/api/airports`, `/api/healthz`

The shared web app can be previewed before setup, but sign-in and protected data operations stay disabled until the new Supabase project is connected. Configure values as Replit Secrets; do not commit a `.env` file or place server-only values in `VITE_*` variables.

## Set up a new Supabase project

These files are for the new project you create. No existing Supabase project was connected or changed. Run the SQL migrations in order; `001_initial_schema.sql` is the existing flight-tracker baseline and `002`/`003` add the travel-agency CRM and privacy workflow.

1. Create the new Supabase project. Choose its region based on your operational and legal requirements; get advice on data-residency obligations rather than assuming that a region alone establishes compliance.
2. Run `supabase/migrations/001_initial_schema.sql`, `002_fleet_and_popia.sql`, and `003_popia_dsr.sql` in order in the Supabase SQL Editor.
3. Set a strong, random database setting for `app.popia_aes_key`, which is used by the `popia_encrypt` and `popia_decrypt` functions:

   ```sql
   ALTER DATABASE postgres SET app.popia_aes_key TO '<your-generated-secret>';
   ```

   Keep this value in your password manager or approved secrets store. Losing it makes encrypted phone, passport, SA ID, and driver-contact fields unreadable. Open a new database connection after changing the setting.

4. Seed airports, airlines, and route reference data. From this folder, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the shell without committing them, then run:

   ```bash
   node scripts/seed-openflights.mjs
   ```

   The script downloads the OpenFlights data dumps, parses quoted CSV fields and `\N` nulls, and upserts in batches of 500. It can be rerun safely.

5. Install the Supabase CLI and link the new project. Disable public sign-ups and invite staff users through Supabase Auth; the app does not provide user registration. Set the site's production redirect URL in Supabase Auth after deployment.

6. Deploy the functions:

   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase functions deploy refresh-flights
   supabase functions deploy cleanup-flights
    supabase functions deploy post-assignment-notify
    supabase functions deploy popia-token-cleanup
    supabase functions deploy tracking-state-broadcast
   ```

7. Provide the following Supabase Edge Function secrets. Use the same Resend values you configure for the API server:

   ```bash
    supabase secrets set RESEND_API_KEY=<resend-key> RESEND_FROM_ADDRESS=<verified-sender>
    supabase secrets set RESEND_FROM_NAME="SA Travel Agency"
    supabase secrets set SUPABASE_URL=<new-project-url> SUPABASE_SERVICE_ROLE_KEY=<server-only-key>
    supabase secrets set APP_BASE_URL=<public-app-url>
    supabase secrets set OPENSKY_CLIENT_ID=<client-id> OPENSKY_CLIENT_SECRET=<client-secret>
   ```

    Set `POPIA_DPO_EMAIL` as a Replit server secret. The database encryption key is configured in PostgreSQL and is not exposed to browser or email function code.

8. Configure Supabase Database Webhooks for `fleet_assignments`: send INSERT events to `post-assignment-notify` and UPDATE events to `tracking-state-broadcast`. Use the service-role bearer header for these server-side functions. API-created assignments are marked as API-notified to avoid duplicate confirmation emails.
9. Enable `pg_cron` and `pg_net`, add the new project's URL and service-role key to Supabase Vault using the placeholder commands in `supabase/schedule-example.sql`, then run that schedule SQL. It refreshes flight data, removes stale flight rows, expires unverified POPIA requests, and cleans rate-limit records.
10. Add these Replit Secrets:

    - Web app: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
    - API server: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
    - Mail/privacy: `RESEND_API_KEY`, `RESEND_FROM_ADDRESS`, `RESEND_FROM_NAME`, `POPIA_DPO_EMAIL`, `APP_BASE_URL`
    - Rate limiting: `POPIA_RATE_LIMIT_HMAC_KEY` (at least 32 characters; never expose it to the browser)
    - Optional OpenSky quota: `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`

The schedule uses Vault-backed secrets. The `vault.create_secret` statements in `schedule-example.sql` are intentionally commented placeholders.

### Deployment status and legal note

The running product remains on the existing Replit web and API workflows. Cloudflare Pages/Workers deployment has not been configured or deployed; it requires a separate tested runtime adapter and Cloudflare project setup. This workspace has not been connected to a Cloudflare account. The privacy controls here are technical safeguards, not a legal certification of POPIA compliance; have the workflow and retention rules reviewed by qualified counsel.

## API overview

| Route | Purpose |
| --- | --- |
| `GET /api/dashboard/summary` | Combined bookings, transfers, fleet, privacy queue, and recent activity |
| `GET` / `POST /api/itineraries` | List and create client flight bookings |
| `GET /api/itineraries/:id` | Booking details and assigned transfers |
| `GET /api/fleet/availability` | Vehicle conflicts for a requested time window |
| `POST /api/fleet/assign` | Assign a vehicle/driver and send itinerary confirmation |
| `PATCH /api/fleet/assignments/:id/tracking-state` | Update transfer tracking status |
| `POST /api/popia/dsr` | Public, rate-limited data-subject request submission |
| `GET /api/popia/verify/:token` | Public email verification |
| `GET` / `PATCH /api/popia/dsr` | Authenticated privacy-request queue and processing |
| `GET /api/flights` | Authenticated live positions, freshness and stale flag |
| `GET /api/flights/summary` | Authenticated total, airborne, and on-ground counts |
| `GET /api/airports` | Authenticated airport reference data |
| `GET /api/healthz` | API health check |

## Checks

Run the workspace type checks and the app production build:

```bash
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/sa-flight-tracker run typecheck
pnpm --filter @workspace/sa-flight-tracker run build
```

## Sources and attribution

- Flight data: [OpenSky Network](https://opensky-network.org/). Use is subject to OpenSky's terms and data-use policies.
- Airport, airline, and route reference data: [OpenFlights](https://openflights.org/data.php), licensed under ODbL.
- Map tiles: [OpenStreetMap](https://www.openstreetmap.org/copyright), subject to the OpenStreetMap tile usage policy.
