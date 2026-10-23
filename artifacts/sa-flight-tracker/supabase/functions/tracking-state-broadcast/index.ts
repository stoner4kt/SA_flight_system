type Row = Record<string, unknown>;

const copy: Record<string, { subject: string; message: string }> = {
  en_route: { subject: "Your driver is on the way", message: "Your driver has started the trip to the pickup point." },
  arrived: { subject: "Your driver has arrived", message: "Your driver has arrived at the pickup point." },
  passenger_onboard: { subject: "Your transfer is underway", message: "Your driver has confirmed that you are on board." },
  completed: { subject: "Your transfer is complete", message: "Your ground transfer has been marked complete." },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

async function supabaseRequest(path: string): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_NOT_CONFIGURED");
  return fetch(`${url.replace(/\/+$/, "")}/rest/v1/${path}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
}

async function sendEmail(to: string, subject: string, html: string, textBody: string): Promise<boolean> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM_ADDRESS");
  if (!apiKey || !from) return false;
  const fromName = Deno.env.get("RESEND_FROM_NAME") ?? "SA Travel Agency";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], subject, html, text: textBody }),
  });
  return response.ok;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  let event: Row;
  try {
    event = record(await request.json());
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }
  if (event.type !== "UPDATE") return json({ skipped: true, reason: "not_an_update" });

  const assignment = record(event.record);
  const previous = record(event.old_record);
  const state = text(assignment.tracking_state);
  if (!state || state === previous.tracking_state || !copy[state]) {
    return json({ skipped: true, reason: "state_not_notifiable" });
  }

  try {
    const itineraryId = text(assignment.itinerary_id);
    if (!itineraryId) return json({ error: "ITINERARY_ID_MISSING" }, 400);
    const response = await supabaseRequest(
      `itineraries?id=eq.${encodeURIComponent(itineraryId)}&select=client_email,client_name,itinerary_ref`,
    );
    if (!response.ok) return json({ error: "BOOKING_LOOKUP_FAILED" }, 502);
    const rows = await response.json() as Row[];
    const itinerary = record(rows[0]);
    const recipient = text(itinerary.client_email);
    if (!recipient) return json({ skipped: true, reason: "recipient_missing" });

    const message = copy[state];
    const reference = text(itinerary.itinerary_ref) ?? "your booking";
    const greeting = text(itinerary.client_name);
    const driver = text(assignment.driver_name) ?? "your driver";
    const pickup = text(assignment.pickup_address) ?? "the pickup point";
    const dropoff = text(assignment.dropoff_address) ?? "your destination";
    const html = `<div style="background:#f5f3ed;padding:28px 12px;font-family:Arial,sans-serif;color:#22303b"><div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd8cc;border-radius:14px;padding:28px">
      <p style="color:#157b72;font-size:12px;letter-spacing:2px">SA TRAVEL AGENCY</p><h1>${escapeHtml(message.subject)}</h1>
      <p>${greeting ? `Hello ${escapeHtml(greeting)}, ` : ""}${escapeHtml(message.message)}</p>
      <p>Driver: ${escapeHtml(driver)}</p><p>Pickup: ${escapeHtml(pickup)}</p><p>Drop-off: ${escapeHtml(dropoff)}</p>
      <p style="color:#66727c">Booking reference: ${escapeHtml(reference)}</p><p>Contact your travel agent if you need assistance.</p></div></div>`;
    const plain = `${message.subject}\n${greeting ? `Hello ${greeting}, ` : ""}${message.message}\nDriver: ${driver}\nPickup: ${pickup}\nDrop-off: ${dropoff}\nBooking reference: ${reference}`;
    const sent = await sendEmail(recipient, `${message.subject} · SA Travel`, html, plain);
    return json({ sent, state, reason: sent ? "sent" : "email_not_configured_or_provider_rejected" }, sent ? 200 : 502);
  } catch {
    return json({ error: "NOTIFICATION_FAILED" }, 500);
  }
});
