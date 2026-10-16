-- Run this in the new project's SQL editor after enabling pg_cron and pg_net.
-- First, create these Vault secrets with your own project URL and service-role
-- key. Do not commit actual values to this file or share the service-role key.
--
-- select vault.create_secret(
--   'https://<project-ref>.supabase.co',
--   'sa_tracker_project_url'
-- );
-- select vault.create_secret(
--   '<service-role-key>',
--   'sa_tracker_service_role_key'
-- );

SELECT cron.schedule(
  'sa-flight-refresh',
  '*/5 * * * *',
  $job$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'sa_tracker_project_url'
      ) || '/functions/v1/refresh-flights',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'sa_tracker_service_role_key'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $job$
);

SELECT cron.schedule(
  'sa-flight-cleanup',
  '0 */6 * * *',
  $job$
    SELECT net.http_post(
      url := (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'sa_tracker_project_url'
      ) || '/functions/v1/cleanup-flights',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret
          FROM vault.decrypted_secrets
          WHERE name = 'sa_tracker_service_role_key'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $job$
);
