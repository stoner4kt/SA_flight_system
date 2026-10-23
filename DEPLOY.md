# SA Travel Agency Workspace — Setup Guide

This guide connects the existing single Replit web app and shared API server to the new Supabase project you create. It does not create or deploy a second CRM app.

## 1. Create and secure the Supabase project

1. Create a new Supabase project. Select a region based on your operational needs and obtain legal advice about data residency and cross-border processing.
2. In **Authentication → Providers → Email**, enable email authentication and confirmations, and turn off public sign-ups.
3. Invite staff accounts from **Authentication → Users**. The app does not expose public staff registration.
4. Add the deployed app URL to the Supabase Auth redirect allow-list when it is known.

## 2. Apply the database schema

Run the SQL files from `artifacts/sa-flight-tracker/supabase/migrations` in this order:

1. `001_initial_schema.sql` — existing flight tracker tables.
2. `002_fleet_and_popia.sql` — itineraries, fleet vehicles, transfers, encrypted PII functions and overlap protection.
3. `003_popia_dsr.sql` — privacy requests, verification expiry, persistent rate limiting and erasure processing.

Run each file in the new project's Supabase SQL Editor. No existing project is modified by these files.

Configure the database encryption setting using a newly generated secret of at least 32 characters:

```sql
ALTER DATABASE postgres SET app.popia_aes_key TO '<your-generated-secret>';
```

Store the value in an approved secrets manager and retain a secure backup. The same value is required to decrypt existing encrypted fields. Reconnect to the database after setting it.

## 3. Configure Replit Secrets

Set these values in the Replit Secrets interface. Do not put service-role keys or private secrets in `VITE_*` variables.

| Secret | Used by |
| --- | --- |
| `VITE_SUPABASE_URL` | Web app |
| `VITE_SUPABASE_ANON_KEY` | Web app |
| `SUPABASE_URL` | API server |
| `SUPABASE_ANON_KEY` | API server JWT validation |
| `SUPABASE_SERVICE_ROLE_KEY` | API server database operations and one-time airport seed |
| `POPIA_RATE_LIMIT_HMAC_KEY` | API server, at least 32 characters |
| `RESEND_API_KEY` | API server email |
| `RESEND_FROM_ADDRESS` | Verified Resend sender |
| `RESEND_FROM_NAME` | Email sender name |
| `POPIA_DPO_EMAIL` | Privacy-team notifications |
| `APP_BASE_URL` | Public web app URL used in email links |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Optional authenticated flight-data quota |

The PII encryption key is configured as the PostgreSQL setting above; it is not exposed to the browser.

## 4. Deploy Supabase Edge Functions

From `artifacts/sa-flight-tracker`, link the Supabase CLI to your new project and deploy:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy refresh-flights
supabase functions deploy cleanup-flights
supabase functions deploy post-assignment-notify
supabase functions deploy popia-token-cleanup
supabase functions deploy tracking-state-broadcast
```

Set the function secrets:

```bash
supabase secrets set SUPABASE_URL=<new-project-url>
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
supabase secrets set RESEND_API_KEY=<resend-key>
supabase secrets set RESEND_FROM_ADDRESS=<verified-sender>
supabase secrets set RESEND_FROM_NAME="SA Travel Agency"
supabase secrets set APP_BASE_URL=<public-web-app-url>
supabase secrets set OPENSKY_CLIENT_ID=<optional-client-id>
supabase secrets set OPENSKY_CLIENT_SECRET=<optional-client-secret>
```

In Supabase **Database → Webhooks**, create:

- `fleet_assignments` **INSERT** → `/functions/v1/post-assignment-notify`
- `fleet_assignments` **UPDATE** → `/functions/v1/tracking-state-broadcast`

Use the service-role bearer header for these server-side webhooks. Assignments created through the API send their itinerary email there and are marked to prevent a duplicate webhook email.

Enable `pg_cron` and `pg_net`, add the project URL and service-role key to Supabase Vault using the commented examples in `supabase/schedule-example.sql`, then run that SQL. It schedules flight refresh and cleanup plus daily POPIA token and rate-limit cleanup.

## 5. Seed airport reference data

From the artifact folder, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the shell without saving them to source control, then run:

```bash
node scripts/seed-openflights.mjs
```

No fictional customers or vehicles are inserted. Add the agency's actual fleet records before assigning transfers.

## 6. Verify the Replit app

```bash
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/sa-flight-tracker run typecheck
pnpm --filter @workspace/sa-flight-tracker run build
```

Then sign in with an invited staff account. Verify booking creation, availability, a transfer assignment, a tracking-state update, and public privacy-request email verification using test data in the new project.

## Cloudflare

Cloudflare Pages/Workers are not deployed or configured here. The current project runs as a Replit-managed Vite app plus a shared Express API service; the Express-to-Workers adapter and Cloudflare account setup require a separate implementation and runtime verification. Do not treat a Cloudflare deployment as complete based on this guide.

## Privacy and legal review

The app includes technical controls for authentication, encrypted selected fields, access policies, verification and rate limiting. These controls do not certify POPIA compliance. Review data-retention periods, notices, cross-border processing, access/erasure exceptions, and incident procedures with qualified counsel before using real customer data.
