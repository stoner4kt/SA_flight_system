function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "SUPABASE_NOT_CONFIGURED" }, 503);

  try {
    const expiry = encodeURIComponent(`lt.${new Date().toISOString()}`);
    const response = await fetch(
      `${url.replace(/\/+$/, "")}/rest/v1/popia_dsr_requests?status=eq.pending&verified_at=is.null&token_expires_at=${expiry}`,
      {
        method: "PATCH",
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          prefer: "return=representation",
        },
        body: JSON.stringify({
          status: "rejected",
          notes: "Auto-rejected: email not verified within 48 hours.",
        }),
      },
    );
    if (!response.ok) return json({ error: "CLEANUP_FAILED" }, 502);
    const expired = await response.json() as unknown[];
    const expiredLimits = encodeURIComponent(`lt.${new Date().toISOString()}`);
    const limitsResponse = await fetch(
      `${url.replace(/\/+$/, "")}/rest/v1/popia_rate_limits?expires_at=${expiredLimits}`,
      {
        method: "DELETE",
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          prefer: "return=representation",
        },
      },
    );
    if (!limitsResponse.ok) return json({ error: "RATE_LIMIT_CLEANUP_FAILED" }, 502);
    const limits = await limitsResponse.json() as unknown[];
    return json({
      expired: Array.isArray(expired) ? expired.length : 0,
      removedRateLimits: Array.isArray(limits) ? limits.length : 0,
    });
  } catch {
    return json({ error: "CLEANUP_FAILED" }, 500);
  }
});
