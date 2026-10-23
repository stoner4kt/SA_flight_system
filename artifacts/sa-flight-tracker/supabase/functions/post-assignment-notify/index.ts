type Row = Record<string, unknown>;

const saAirports = new Set(["CPT", "JNB", "DUR", "PLZ", "GRJ", "ELS", "BFN", "HDS", "UTN", "KIM", "MQP", "NTY", "PHW", "SIS", "VRU", "WDU", "PRY", "AFD"]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function formatDate(value: string | null): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Date to be confirmed";
  return new Intl.DateTimeFormat("en-ZA", {
    weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Johannesburg",
  }).format(new Date(value));
}

function formatTime(value: string | null): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Time to be confirmed";
  return new Intl.DateTimeFormat("en-ZA", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Johannesburg",
  }).format(new Date(value));
}

function normalizeSegment(value: unknown): Row | null {
  const item = record(value);
  const departure = record(item.departure);
  const arrival = record(item.arrival);
  const origin = text(item.origin) ?? text(item.departureAirport) ?? text(departure.iataCode) ?? text(record(item.origin).iata_code);
  const destination = text(item.destination) ?? text(item.arrivalAirport) ?? text(arrival.iataCode) ?? text(record(item.destination).iata_code);
  const departureTime = text(item.departure_time) ?? text(item.departureTime) ?? text(item.departure_at) ?? text(departure.at) ?? text(item.departing_at);
  const arrivalTime = text(item.arrival_time) ?? text(item.arrivalTime) ?? text(item.arrival_at) ?? text(arrival.at) ?? text(item.arriving_at);
  if (!origin || !destination || !departureTime || !arrivalTime) return null;
  const carrier = record(item.marketing_carrier);
  return {
    flight_number: text(item.flight_number) ?? text(item.flightNumber) ?? text(item.number),
    airline: text(item.airline) ?? text(item.carrier) ?? text(carrier.name) ?? text(item.carrierCode),
    origin: origin.toUpperCase(),
    destination: destination.toUpperCase(),
    departure_time: departureTime,
    arrival_time: arrivalTime,
    terminal: text(item.terminal) ?? text(departure.terminal),
  };
}

function extractSegments(value: unknown): Row[] {
  const root = record(value);
  const normalized = Array.isArray(root.segments) ? root.segments : Array.isArray(root.flight_segments) ? root.flight_segments : null;
  if (normalized) return normalized.map(normalizeSegment).filter((item): item is Row => !!item);
  const data = record(root.data);
  const offers = Array.isArray(data.flightOffers) ? data.flightOffers : [];
  const firstOffer = record(offers[0]);
  const itineraries = Array.isArray(firstOffer.itineraries) ? firstOffer.itineraries : [];
  const amadeusSegments = itineraries.flatMap((value) => {
    const itinerary = record(value);
    return Array.isArray(itinerary.segments) ? itinerary.segments : [];
  });
  if (amadeusSegments.length) return amadeusSegments.map(normalizeSegment).filter((item): item is Row => !!item);
  const slices = Array.isArray(root.slices) ? root.slices : [];
  return slices.flatMap((value) => {
    const slice = record(value);
    return Array.isArray(slice.segments) ? slice.segments.map(normalizeSegment).filter((item): item is Row => !!item) : [];
  });
}

function segmentHtml(segment: Row, index: number, count: number): string {
  const origin = String(segment.origin);
  const destination = String(segment.destination);
  const international = !(saAirports.has(origin) && saAirports.has(destination));
  const departure = String(segment.departure_time);
  const arrival = String(segment.arrival_time);
  return `<section style="padding:18px 0;border-bottom:1px solid #2d3555">
    <p style="margin:0 0 8px;color:#8892a4;font-size:12px">${international ? "🌍 International" : "🇿🇦 South Africa"} · Segment ${index + 1} of ${count}</p>
    <h2 style="margin:0 0 12px;color:#e8eaf0;font-size:20px">${escapeHtml(origin)} → ${escapeHtml(destination)}</h2>
    <p style="margin:4px 0;color:#8892a4">Flight: ${escapeHtml(String(segment.flight_number ?? "To be confirmed"))} · Airline: ${escapeHtml(String(segment.airline ?? "To be confirmed"))}</p>
    <p style="margin:4px 0;color:#8892a4">Date: ${escapeHtml(formatDate(departure))}</p>
    <p style="margin:4px 0;color:#8892a4">Departure: ${escapeHtml(formatTime(departure))}${segment.terminal ? ` · Terminal ${escapeHtml(String(segment.terminal))}` : ""}</p>
    <p style="margin:4px 0;color:#8892a4">Arrival: ${escapeHtml(formatTime(arrival))}</p>
  </section>`;
}

async function supabaseRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_NOT_CONFIGURED");
  return fetch(`${url.replace(/\/+$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...init.headers,
    },
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
  if (event.type !== "INSERT") return json({ skipped: true, reason: "not_an_insert" });
  const assignment = record(event.record);
  if (assignment.notification_owner === "api") return json({ skipped: true, reason: "handled_by_api" });

  try {
    const itineraryId = text(assignment.itinerary_id);
    const vehicleId = text(assignment.vehicle_id);
    if (!itineraryId || !vehicleId) return json({ error: "INVALID_ASSIGNMENT" }, 400);

    const [itineraryResponse, vehicleResponse] = await Promise.all([
      supabaseRequest(`itineraries?id=eq.${encodeURIComponent(itineraryId)}&select=*`),
      supabaseRequest(`fleet_vehicles?id=eq.${encodeURIComponent(vehicleId)}&select=registration,make_model`),
    ]);
    if (!itineraryResponse.ok || !vehicleResponse.ok) return json({ error: "BOOKING_LOOKUP_FAILED" }, 502);
    const itineraries = await itineraryResponse.json() as Row[];
    const vehicles = await vehicleResponse.json() as Row[];
    const itinerary = record(itineraries[0]);
    const vehicle = record(vehicles[0]);
    const recipient = text(itinerary.client_email);
    if (!recipient) return json({ skipped: true, reason: "recipient_missing" });

    let segments = extractSegments(itinerary.flight_data);
    const segmentMarkup = segments.length
      ? segments.map((segment, index) => segmentHtml(segment, index, segments.length)).join("")
      : "<p>Flight details will be confirmed by your travel agent.</p>";
    const ref = escapeHtml(String(itinerary.itinerary_ref ?? ""));
    const passenger = escapeHtml(String(itinerary.client_name ?? "Passenger"));
    const pickup = escapeHtml(String(assignment.pickup_address ?? ""));
    const dropoff = escapeHtml(String(assignment.dropoff_address ?? ""));
    const driver = escapeHtml(String(assignment.driver_name ?? ""));
    const registration = escapeHtml(String(vehicle.registration ?? "Registration pending"));
    const model = escapeHtml(String(vehicle.make_model ?? "Vehicle"));
    const pickupAt = String(assignment.pickup_at ?? "");
    const subjectSegment = segments[0];
    const subject = `Your Itinerary — ${String(itinerary.client_name ?? "Passenger")} | ${String(subjectSegment?.origin ?? "Flight")} -> ${String(subjectSegment?.destination ?? "details")} | ${formatDate(text(subjectSegment?.departure_time))}`;
    const base = Deno.env.get("APP_BASE_URL")?.replace(/\/+$/, "");
    const privacy = base ? `<p style="color:#8892a4;font-size:12px"><a href="${escapeHtml(base)}/privacy/request?type=objection" style="color:#00b4d8">Manage communication preferences</a></p>` : "";
    const html = `<div style="background:#0f1117;padding:28px 12px;font-family:Arial,sans-serif;color:#e8eaf0"><div style="max-width:600px;margin:0 auto;background:#1a1f2e;border:1px solid #2d3555;border-radius:14px;padding:28px">
      <p style="color:#00b4d8;font-size:12px;letter-spacing:2px">SA TRAVEL AGENCY</p><h1>Booking Confirmation</h1>
      <p style="color:#8892a4">Reference ${ref} · Issued ${escapeHtml(formatDate(new Date().toISOString()))}</p>
      <div style="padding:16px;background:#0f1117;border-radius:10px"><small style="color:#8892a4">PASSENGER</small><p style="margin:8px 0 0;font-size:18px">${passenger}</p></div>
      ${segmentMarkup}
      <div style="margin-top:18px;padding:16px;background:#0f1117;border-radius:10px"><p style="color:#00b4d8">GROUND TRANSFER</p>
      <p>Pick-up: ${pickup}</p><p>Drop-off: ${dropoff}</p><p>Date/time: ${escapeHtml(formatDate(pickupAt))}, ${escapeHtml(formatTime(pickupAt))}</p>
      <p>Vehicle: ${model} · ${registration}</p><p>Driver: ${driver}</p></div>
      <p style="margin-top:22px;color:#8892a4">Safe travels. Reply to this email for changes.</p>${privacy}</div></div>`;
    const plain = `SA Travel Agency — Booking Confirmation\nReference: ${itinerary.itinerary_ref ?? ""}\nPassenger: ${itinerary.client_name ?? ""}\nSegments: ${segments.length}\nPick-up: ${assignment.pickup_address ?? ""}\nDrop-off: ${assignment.dropoff_address ?? ""}\nPickup: ${formatDate(pickupAt)}, ${formatTime(pickupAt)}\nVehicle: ${vehicle.make_model ?? "Vehicle"} - ${vehicle.registration ?? "Registration pending"}\nDriver: ${assignment.driver_name ?? ""}`;
    const sent = await sendEmail(recipient, subject, html, plain);
    return json({ sent, reason: sent ? "sent" : "email_not_configured_or_provider_rejected" }, sent ? 200 : 502);
  } catch {
    return json({ error: "NOTIFICATION_FAILED" }, 500);
  }
});
