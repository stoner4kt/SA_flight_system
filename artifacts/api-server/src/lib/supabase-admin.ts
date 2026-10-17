import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class SupabaseConfigError extends Error {
  readonly code = "SUPABASE_NOT_CONFIGURED";
}

let adminClient: SupabaseClient | null = null;
let publicAuthClient: SupabaseClient | null = null;

function requireProjectUrl(): string {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  if (!url) throw new SupabaseConfigError("Supabase project URL is not configured.");
  return url;
}

export function getAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;

  const url = requireProjectUrl();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new SupabaseConfigError("Supabase server credentials are not configured.");
  }

  adminClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return adminClient;
}

export function getPublicAuthClient(): SupabaseClient {
  if (publicAuthClient) return publicAuthClient;

  const url = requireProjectUrl();
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new SupabaseConfigError("Supabase public auth credentials are not configured.");
  }

  publicAuthClient = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return publicAuthClient;
}

export function safeDatabaseErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/i.test(code)) return code;
  }
  if (error instanceof SupabaseConfigError) return error.code;
  return "DATABASE_ERROR";
}
