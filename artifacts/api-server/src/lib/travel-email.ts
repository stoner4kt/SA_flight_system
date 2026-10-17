type FlightSegment = {
  flight_number: string | null;
  airline: string | null;
  origin: string;
  destination: string;
  departure_time: string;
  arrival_time: string;
  terminal: string | null;
};

type ItineraryEmailData = {
  id: string;
  itinerary_ref: string;
  client_name: string;
  client_email: string;
  flight_data: unknown;
};

type AssignmentEmailData = {
  id: string;
  driver_name: string;
  pickup_at: string;
  dropoff_at: string;
  pickup_address: string;
  dropoff_address: string;
  driver_contact?: string | null;
  fleet_vehicles?: { registration?: string; make_model?: string } | null;
};

type ResendResult = { sent: boolean; message: string };

const SOUTH_AFRICAN_AIRPORTS = new Set([
  "CPT", "JNB", "DUR", "PLZ", "GRJ", "ELS", "BFN", "HDS", "UTN",
  "KIM", "MQP", "NTY", "PHW", "SIS", "VRU", "WDU", "PRY", "AFD",
]);

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function segmentFrom(value: unknown): FlightSegment | null {
  const item = record(value);
  const origin = text(item.origin) ?? text(item.departureAirport);
  const destination = text(item.destination) ?? text(item.arrivalAirport);
  const departureTime =
    text(item.departure_time) ?? text(item.departureTime) ?? text(item.departure_at);
  const arrivalTime =
    text(item.arrival_time) ?? text(item.arrivalTime) ?? text(item.arrival_at);

  if (!origin || !destination || !departureTime || !arrivalTime) return null;
  return {
    flight_number: text(item.flight_number) ?? text(item.flightNumber),
    airline: text(item.airline) ?? text(item.carrier),
    origin: origin.toUpperCase(),
    destination: destination.toUpperCase(),
    departure_time: departureTime,
    arrival_time: arrivalTime,
    terminal: text(item.terminal),
  };
}

export function extractSegments(flightData: unknown): FlightSegment[] {
  const root = record(flightData);
  const normalized = Array.isArray(root.segments)
    ? root.segments
    : Array.isArray(root.flight_segments)
      ? root.flight_segments
      : null;
  if (normalized) return normalized.map(segmentFrom).filter((item): item is FlightSegment => item !== null);

  const amadeus = record(root.data);
  const offers = Array.isArray(amadeus.flightOffers) ? amadeus.flightOffers : [];
  const firstOffer = record(offers[0]);
  const itineraries = Array.isArray(firstOffer.itineraries) ? firstOffer.itineraries : [];
  const amadeusSegments = itineraries.flatMap((itinerary) => {
    const item = record(itinerary);
    return Array.isArray(item.segments) ? item.segments : [];
  });
  if (amadeusSegments.length) {
    return amadeusSegments
      .map((raw) => {
        const item = record(raw);
        const departure = record(item.departure);
        const arrival = record(item.arrival);
        return segmentFrom({
          flight_number: item.number,
          airline: item.carrierCode,
          origin: departure.iataCode,
          destination: arrival.iataCode,
          departure_time: departure.at,
          arrival_time: arrival.at,
          terminal: departure.terminal,
        });
      })
      .filter((item): item is FlightSegment => item !== null);
  }

  const slices = Array.isArray(root.slices) ? root.slices : [];
  return slices.flatMap((slice) => {
    const sliceRecord = record(slice);
    const segments = Array.isArray(sliceRecord.segments) ? sliceRecord.segments : [];
    return segments
      .map((raw) => {
        const item = record(raw);
        const origin = record(item.origin);
        const destination = record(item.destination);
        return segmentFrom({
          flight_number: item.flight_number,
          airline: item.marketing_carrier?.name ?? item.marketing_carrier,
          origin: origin.iata_code,
          destination: destination.iata_code,
          departure_time: item.departing_at,
          arrival_time: item.arriving_at,
          terminal: record(item.origin_terminal).name,
        });
      })
      .filter((item): item is FlightSegment => item !== null);
  });
}

export function isInternationalLeg(origin: string, destination: string): boolean {
  return !(SOUTH_AFRICAN_AIRPORTS.has(origin.toUpperCase()) &&
    SOUTH_AFRICAN_AIRPORTS.has(destination.toUpperCase()));
}

export function formatSADate(isoString: string | null | undefined): string {
  if (!isoString) return "Date to be confirmed";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "Date to be confirmed";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Johannesburg",
  }).format(date);
}

export function formatSATime(isoString: string | null | undefined): string {
  if (!isoString) return "Time to be confirmed";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "Time to be confirmed";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Johannesburg",
  }).format(date);
}

function renderSegments(segments: FlightSegment[]): { html: string; text: string } {
  if (segments.length === 0) {
    return { html: "<p>Flight details will be confirmed by your travel agent.</p>", text: "Flight details will be confirmed by your travel agent." };
  }

  const html = segments.map((segment, index) => {
    const domestic = !isInternationalLeg(segment.origin, segment.destination);
    return `<section style="padding:18px 0;border-bottom:1px solid #2d3555">
      <p style="margin:0 0 8px;color:#8892a4;font-size:12px">Segment ${index + 1} of ${segments.length} · ${domestic ? "South Africa" : "International"}</p>
      <h2 style="margin:0 0 12px;color:#e8eaf0;font-size:20px">${escapeHtml(segment.origin)} → ${escapeHtml(segment.destination)}</h2>
      <p style="margin:4px 0;color:#8892a4">Flight: ${escapeHtml(segment.flight_number ?? "To be confirmed")} · Airline: ${escapeHtml(segment.airline ?? "To be confirmed")}</p>
      <p style="margin:4px 0;color:#8892a4">Date: ${escapeHtml(formatSADate(segment.departure_time))}</p>
      <p style="margin:4px 0;color:#8892a4">Departure: ${escapeHtml(formatSATime(segment.departure_time))}${segment.terminal ? ` · Terminal ${escapeHtml(segment.terminal)}` : ""}</p>
      <p style="margin:4px 0;color:#8892a4">Arrival: ${escapeHtml(formatSATime(segment.arrival_time))}</p>
    </section>`;
  }).join("");

  const plainText = segments.map((segment, index) =>
    `Segment ${index + 1} of ${segments.length}\n` +
    `${segment.origin} -> ${segment.destination}\n` +
    `Flight: ${segment.flight_number ?? "To be confirmed"} | Airline: ${segment.airline ?? "To be confirmed"}\n` +
    `Date: ${formatSADate(segment.departure_time)}\n` +
    `Departure: ${formatSATime(segment.departure_time)}${segment.terminal ? ` | Terminal ${segment.terminal}` : ""}\n` +
    `Arrival: ${formatSATime(segment.arrival_time)}`
  ).join("\n\n");
  return { html, text: plainText };
}

async function sendResendEmail(
  recipient: string,
  subject: string,
  html: string,
  plainText: string,
  tags: Array<{ name: string; value: string }> = [],
): Promise<ResendResult> {
  const apiKey = env("RESEND_API_KEY");
  const fromAddress = env("RESEND_FROM_ADDRESS");
  if (!apiKey || !fromAddress) {
    return { sent: false, message: "Resend is not configured; no email was sent." };
  }

  const fromName = env("RESEND_FROM_NAME") ?? "SA Travel Agency";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${fromName} <${fromAddress}>`,
        to: [recipient],
        subject,
        html,
        text: plainText,
        tags,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { sent: false, message: "The email provider did not accept the message." };
    }
    return { sent: true, message: "Email sent." };
  } catch {
    return { sent: false, message: "The email provider could not be reached." };
  }
}

function itineraryEmailHtml(
  itinerary: ItineraryEmailData,
  assignment: AssignmentEmailData,
): string {
  const segments = renderSegments(extractSegments(itinerary.flight_data));
  const reference = escapeHtml(itinerary.itinerary_ref);
  const person = escapeHtml(itinerary.client_name);
  const vehicle = assignment.fleet_vehicles;
  const baseUrl = env("APP_BASE_URL");
  const privacyLink = baseUrl
    ? `${escapeHtml(baseUrl.replace(/\/+$/, ""))}/privacy/request?type=objection`
    : null;
  return `<div style="background:#0f1117;padding:28px 12px;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8eaf0">
    <div style="max-width:600px;margin:0 auto;background:#1a1f2e;border:1px solid #2d3555;border-radius:14px;padding:28px">
      <p style="margin:0;color:#00b4d8;font-size:12px;text-transform:uppercase;letter-spacing:2px">SA Travel Agency</p>
      <h1 style="margin:8px 0 6px;font-size:26px">Booking Confirmation</h1>
      <p style="margin:0;color:#8892a4">Reference ${reference} · Issued ${escapeHtml(formatSADate(new Date().toISOString()))}</p>
      <div style="margin-top:22px;padding:16px;background:#0f1117;border-radius:10px">
        <p style="margin:0 0 6px;color:#8892a4;font-size:11px;letter-spacing:1px">PASSENGER</p>
        <p style="margin:0;font-size:18px;font-weight:600">${person}</p>
      </div>
      ${segments.html}
      <div style="margin-top:18px;padding:16px;background:#0f1117;border-radius:10px">
        <p style="margin:0 0 10px;color:#00b4d8;font-size:12px;text-transform:uppercase;letter-spacing:1px">Ground transfer</p>
        <p style="margin:5px 0">Pick-up: ${escapeHtml(assignment.pickup_address)}</p>
        <p style="margin:5px 0">Drop-off: ${escapeHtml(assignment.dropoff_address)}</p>
        <p style="margin:5px 0">Date/time: ${escapeHtml(formatSADate(assignment.pickup_at))}, ${escapeHtml(formatSATime(assignment.pickup_at))}</p>
        <p style="margin:5px 0">Vehicle: ${escapeHtml(vehicle?.make_model ?? "Vehicle")} · ${escapeHtml(vehicle?.registration ?? "Registration pending")}</p>
        <p style="margin:5px 0">Driver: ${escapeHtml(assignment.driver_name)}</p>
      </div>
      <p style="margin:22px 0 5px;color:#8892a4">Safe travels. Reply to this email for changes.</p>
      ${privacyLink ? `<p style="margin:0;color:#8892a4;font-size:12px"><a href="${privacyLink}" style="color:#00b4d8">Manage communication preferences</a></p>` : ""}
    </div>
  </div>`;
}

export async function sendItineraryEmail(
  itinerary: ItineraryEmailData,
  assignment: AssignmentEmailData,
): Promise<ResendResult> {
  const segments = renderSegments(extractSegments(itinerary.flight_data));
  const subjectSegment = extractSegments(itinerary.flight_data)[0];
  const subject = `Your Itinerary — ${itinerary.client_name} | ${subjectSegment?.origin ?? "Flight"} -> ${subjectSegment?.destination ?? "details"} | ${formatSADate(subjectSegment?.departure_time)}`;
  const vehicle = assignment.fleet_vehicles;
  const plainText =
    `SA Travel Agency — Booking Confirmation\nReference: ${itinerary.itinerary_ref}\n` +
    `PASSENGER\n${itinerary.client_name}\n\n${segments.text}\n\n` +
    `GROUND TRANSFER\nPick-up: ${assignment.pickup_address}\n` +
    `Drop-off: ${assignment.dropoff_address}\n` +
    `Date/time: ${formatSADate(assignment.pickup_at)}, ${formatSATime(assignment.pickup_at)}\n` +
    `Vehicle: ${vehicle?.make_model ?? "Vehicle"} - ${vehicle?.registration ?? "Registration pending"}\n` +
    `Driver: ${assignment.driver_name}\n\nSafe travels. Reply to this email for changes.`;
  return sendResendEmail(
    itinerary.client_email,
    subject,
    itineraryEmailHtml(itinerary, assignment),
    plainText,
    [
      { name: "type", value: "itinerary" },
      { name: "itinerary_id", value: itinerary.id },
    ],
  );
}

export async function sendPOPIAVerificationEmail(
  subjectEmail: string,
  subjectName: string | null,
  requestType: string,
  verifyLink: string,
): Promise<ResendResult> {
  const name = subjectName ? ` ${escapeHtml(subjectName)}` : "";
  const title = `Confirm your ${requestType} request — SA Travel Agency`;
  const safeLink = escapeHtml(verifyLink);
  const html = `<div style="background:#0f1117;padding:28px 12px;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8eaf0">
    <div style="max-width:600px;margin:0 auto;background:#1a1f2e;border:1px solid #2d3555;border-radius:14px;padding:28px">
      <p style="color:#00b4d8;font-size:12px;text-transform:uppercase;letter-spacing:2px">SA Travel Agency</p>
      <h1 style="font-size:22px">Confirm your ${escapeHtml(requestType)} request</h1>
      <p>Hello${name}, use the secure link below to confirm this request. It expires in 48 hours.</p>
      <p><a href="${safeLink}" style="display:inline-block;background:#00b4d8;color:#0f1117;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">Verify request</a></p>
      <p style="color:#8892a4;font-size:13px">If you did not make this request, you can ignore this message.</p>
    </div></div>`;
  const plain = `SA Travel Agency\nConfirm your ${requestType} request\n\nOpen this link within 48 hours to verify your request:\n${verifyLink}\n\nIf you did not make this request, ignore this message.`;
  return sendResendEmail(subjectEmail, title, html, plain, [{ name: "type", value: "popia-verification" }]);
}

export async function sendDPONotification(
  dpoEmail: string,
  requestType: string,
  subjectEmail: string,
  subjectName: string | null,
  dashboardLink: string,
): Promise<ResendResult> {
  const subject = `[ACTION REQUIRED] POPIA DSR — ${requestType}`;
  const html = `<div style="background:#0f1117;padding:28px 12px;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8eaf0">
    <div style="max-width:600px;margin:0 auto;background:#1a1f2e;border:1px solid #2d3555;border-radius:14px;padding:28px">
      <p style="color:#00b4d8;font-size:12px;text-transform:uppercase;letter-spacing:2px">SA Travel Agency</p>
      <h1 style="font-size:22px">Verified data-subject request</h1>
      <p>Request type: ${escapeHtml(requestType)}</p>
      <p>Subject name: ${escapeHtml(subjectName ?? "Not provided")}</p>
      <p>Subject email: ${escapeHtml(subjectEmail)}</p>
      <p>Response deadline: 30 days from verification.</p>
      <p><a href="${escapeHtml(dashboardLink)}" style="color:#00b4d8">Open the privacy dashboard</a></p>
    </div></div>`;
  const plain = `Verified data-subject request\nType: ${requestType}\nSubject: ${subjectName ?? "Not provided"}\nEmail: ${subjectEmail}\nResponse deadline: 30 days from verification.\n${dashboardLink}`;
  return sendResendEmail(dpoEmail, subject, html, plain, [{ name: "type", value: "popia-dpo" }]);
}

export async function sendErasureConfirmation(
  subjectEmail: string,
  recordCount: number,
): Promise<ResendResult> {
  const subject = "Your data request has been completed — SA Travel Agency";
  const html = `<div style="background:#0f1117;padding:28px 12px;font-family:'Helvetica Neue',Arial,sans-serif;color:#e8eaf0">
    <div style="max-width:600px;margin:0 auto;background:#1a1f2e;border:1px solid #2d3555;border-radius:14px;padding:28px">
      <p style="color:#00b4d8;font-size:12px;text-transform:uppercase;letter-spacing:2px">SA Travel Agency</p>
      <h1 style="font-size:22px">Your erasure request is complete</h1>
      <p>We redacted ${recordCount} booking record(s) associated with your request.</p>
      <p style="color:#8892a4">This confirmation relates to your data request only.</p>
    </div></div>`;
  const plain = `SA Travel Agency\nYour erasure request is complete.\nWe redacted ${recordCount} booking record(s) associated with your request.`;
  return sendResendEmail(subjectEmail, subject, html, plain, [{ name: "type", value: "popia-erasure" }]);
}
