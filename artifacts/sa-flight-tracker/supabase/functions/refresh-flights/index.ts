import { createClient } from "npm:@supabase/supabase-js@2";

type OpenSkyState = unknown[];

interface OpenSkyResponse {
  states?: OpenSkyState[] | null;
}

interface FlightRow {
  icao24: string;
  callsign: string | null;
  origin_country: string | null;
  longitude: number;
  latitude: number;
  baro_altitude: number | null;
  geo_altitude: number | null;
  on_ground: boolean;
  velocity: number | null;
  true_track: number | null;
  vertical_rate: number | null;
  squawk: string | null;
  spi: boolean;
  position_source: number | null;
  last_contact: number | null;
  category: number | null;
  updated_at: string;
}

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const bounds = { lamin: -35, lomin: 16, lamax: -22, lomax: 33 };

function textAt(state: OpenSkyState, index: number): string | null {
  const value = state[index];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function numberAt(state: OpenSkyState, index: number): number | null {
  const value = state[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function openSkyToken(): Promise<string | null> {
  const clientId = Deno.env.get("OPENSKY_CLIENT_ID");
  const clientSecret = Deno.env.get("OPENSKY_CLIENT_SECRET");
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error("Both OpenSky OAuth secrets must be configured.");
  }

  const response = await fetch(OPENSKY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenSky OAuth failed with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string") {
    throw new Error("OpenSky OAuth response contained no access token.");
  }
  return body.access_token;
}

async function fetchStates(): Promise<OpenSkyResponse> {
  const token = await openSkyToken();
  const query = new URLSearchParams({
    lamin: String(bounds.lamin),
    lomin: String(bounds.lomin),
    lamax: String(bounds.lamax),
    lomax: String(bounds.lomax),
  });
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${OPENSKY_STATES_URL}?${query}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return (await response.json()) as OpenSkyResponse;
      const error = new Error(`OpenSky returned HTTP ${response.status}.`);
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("OpenSky could not be reached.");
}

function toFlightRow(state: OpenSkyState): FlightRow | null {
  const icao24 = textAt(state, 0)?.toLowerCase();
  const longitude = numberAt(state, 5);
  const latitude = numberAt(state, 6);
  if (!icao24 || longitude === null || latitude === null) return null;

  return {
    icao24,
    callsign: textAt(state, 1)?.toUpperCase() ?? null,
    origin_country: textAt(state, 2),
    longitude,
    latitude,
    baro_altitude: numberAt(state, 7),
    geo_altitude: numberAt(state, 13),
    on_ground: state[8] === true,
    velocity: numberAt(state, 9),
    true_track: numberAt(state, 10),
    vertical_rate: numberAt(state, 11),
    squawk: textAt(state, 14),
    spi: state[15] === true,
    position_source: numberAt(state, 16),
    last_contact: numberAt(state, 4),
    category: numberAt(state, 17),
    updated_at: new Date().toISOString(),
  };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json(
      { error: "Supabase function environment is incomplete." },
      { status: 500 },
    );
  }

  try {
    const body = await fetchStates();
    const flights = (body.states ?? [])
      .map(toFlightRow)
      .filter((flight): flight is FlightRow => flight !== null);
    if (flights.length > 0) {
      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await supabase
        .from("live_flights")
        .upsert(flights, { onConflict: "icao24" });
      if (error) throw error;
    }

    console.info("OpenSky snapshot upserted", { count: flights.length });
    return Response.json({
      status: "ok",
      upserted: flights.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("OpenSky refresh failed", error);
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "OpenSky refresh failed.",
      },
      { status: 502 },
    );
  }
});
