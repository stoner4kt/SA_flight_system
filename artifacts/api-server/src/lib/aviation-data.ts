import {
  type Airport,
  type AirportRoute,
  type Flight,
  type FlightsResponse,
} from "@workspace/api-zod";
import { logger } from "./logger";

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const AIRPORTS_URL =
  "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat";
const AIRLINES_URL =
  "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat";
const ROUTES_URL =
  "https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat";
const SA_BOUNDS = { lamin: -35, lomin: 16, lamax: -22, lomax: 33 };
const FLIGHT_CACHE_MS = 5 * 60 * 1000;
const STALE_CACHE_MAX_MS = 30 * 60 * 1000;
const REFERENCE_CACHE_MS = 24 * 60 * 60 * 1000;

type OpenSkyState = Array<
  string | number | boolean | null | string[] | number[]
>;

interface OpenSkyResponse {
  time?: number;
  states?: OpenSkyState[] | null;
}

interface SupabaseFlightRow {
  icao24: string;
  callsign: string | null;
  origin_country: string | null;
  longitude: number | null;
  latitude: number | null;
  baro_altitude: number | null;
  geo_altitude: number | null;
  on_ground: boolean | null;
  velocity: number | null;
  true_track: number | null;
  vertical_rate: number | null;
  squawk: string | null;
  last_contact: number | null;
  position_source: number | null;
  updated_at: string;
}

interface SupabaseAirportRow {
  airport_id: number;
  name: string;
  city: string | null;
  country: string;
  iata_code: string | null;
  icao_code: string | null;
  latitude: number;
  longitude: number;
  altitude: number | null;
  timezone: number | null;
  tz_database: string | null;
  type: string | null;
}

interface SupabaseRouteRow {
  route_key: string;
  airline_code: string;
  source_airport_code: string;
  destination_airport_code: string;
  stops: number;
  equipment: string | null;
}

interface FlightCache {
  data: FlightsResponse;
  cachedAt: number;
}

interface ReferenceCache<T> {
  data: T;
  cachedAt: number;
}

let flightCache: FlightCache | undefined;
let pendingFlightRefresh: Promise<FlightsResponse> | undefined;
let airportsCache: ReferenceCache<Airport[]> | undefined;
let pendingAirportsLoad: Promise<Airport[]> | undefined;
let airportRoutesCache: ReferenceCache<AirportRoute[]> | undefined;
let pendingAirportRoutesLoad: Promise<AirportRoute[]> | undefined;
let airlineNamesCache: ReferenceCache<Map<string, string>> | undefined;
let openskyToken: { value: string; expiresAt: number } | undefined;

function cleanCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return !code || code === "\\N" ? null : code;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function csvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (char === '"' && quoted && csv[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  return rows;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`Reference data request failed with HTTP ${response.status}`);
  }
  return response.text();
}

function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url && !key) return null;
  if (!url || !key) {
    throw new Error(
      "Set both SUPABASE_URL and SUPABASE_ANON_KEY, or leave both unset.",
    );
  }
  return { url, key };
}

async function supabaseSelect<T>(
  table: "airports" | "live_flights" | "routes",
  params: Record<string, string>,
): Promise<T[]> {
  const config = supabaseConfig();
  if (!config) return [];

  const url = new URL(`${config.url}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Supabase ${table} query failed with HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error(`Supabase ${table} query returned an invalid response`);
  }
  return body as T[];
}

async function getOpenSkyToken(): Promise<string | undefined> {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error(
      "OpenSky OAuth requires both OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.",
    );
  }
  if (openskyToken && openskyToken.expiresAt > Date.now() + 30_000) {
    return openskyToken.value;
  }

  const response = await fetch(OPENSKY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`OpenSky OAuth failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof body.access_token !== "string") {
    throw new Error("OpenSky OAuth returned no access token.");
  }
  const expiresIn =
    typeof body.expires_in === "number" ? body.expires_in : 300;
  openskyToken = {
    value: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return openskyToken.value;
}

async function fetchStates(): Promise<OpenSkyResponse> {
  const params = new URLSearchParams({
    lamin: String(SA_BOUNDS.lamin),
    lomin: String(SA_BOUNDS.lomin),
    lamax: String(SA_BOUNDS.lamax),
    lomax: String(SA_BOUNDS.lomax),
  });
  const token = await getOpenSkyToken();
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${OPENSKY_STATES_URL}?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return (await response.json()) as OpenSkyResponse;

      const error = new Error(`OpenSky returned HTTP ${response.status}`);
      if (
        attempt < 2 &&
        (response.status === 429 || response.status >= 500)
      ) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      throw error;
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("OpenSky could not be reached.");
}

async function getAirlineNames(): Promise<Map<string, string>> {
  if (
    airlineNamesCache &&
    Date.now() - airlineNamesCache.cachedAt < REFERENCE_CACHE_MS
  ) {
    return airlineNamesCache.data;
  }

  try {
    const rows = csvRows(await fetchText(AIRLINES_URL));
    const names = new Map<string, string>();
    for (const row of rows) {
      const icao = cleanCode(row[4])?.toUpperCase();
      const iata = cleanCode(row[3])?.toUpperCase();
      const name = cleanCode(row[1]);
      if (name) {
        if (icao) names.set(icao, name);
        if (iata) names.set(iata, name);
      }
    }
    airlineNamesCache = { data: names, cachedAt: Date.now() };
    return names;
  } catch (error) {
    logger.warn({ err: error }, "Unable to load OpenFlights airline data");
    return airlineNamesCache?.data ?? new Map<string, string>();
  }
}

function flightFromState(
  state: OpenSkyState,
  airlineNames: Map<string, string>,
): Flight | null {
  const icao24 = cleanCode(state[0])?.toLowerCase();
  const latitude = finiteNumber(state[6]);
  const longitude = finiteNumber(state[5]);
  if (!icao24 || latitude === null || longitude === null) return null;

  const callsign = cleanCode(state[1])?.toUpperCase() ?? null;
  const prefix = callsign?.slice(0, 3).trim();
  return {
    icao24,
    callsign,
    originCountry: cleanCode(state[2]),
    longitude,
    latitude,
    baroAltitude: finiteNumber(state[7]),
    geoAltitude: finiteNumber(state[13]),
    onGround: state[8] === true,
    velocity: finiteNumber(state[9]),
    trueTrack: finiteNumber(state[10]),
    verticalRate: finiteNumber(state[11]),
    squawk: cleanCode(state[14]),
    lastContact: finiteNumber(state[4]),
    category:
      typeof state[17] === "number" && Number.isFinite(state[17])
        ? state[17]
        : null,
    airlineName: prefix ? airlineNames.get(prefix) ?? null : null,
  };
}

async function fetchOpenSkySnapshot(
  warning: string | null,
): Promise<FlightsResponse> {
  const [body, airlineNames] = await Promise.all([
    fetchStates(),
    getAirlineNames(),
  ]);
  const flights = (body.states ?? [])
    .map((state) => flightFromState(state, airlineNames))
    .filter((flight): flight is Flight => flight !== null);
  return {
    flights,
    fetchedAt: new Date(),
    stale: false,
    warning,
  };
}

function flightFromSupabase(
  row: SupabaseFlightRow,
  airlineNames: Map<string, string>,
): Flight {
  const callsign = cleanCode(row.callsign)?.toUpperCase() ?? null;
  const prefix = callsign?.slice(0, 3).trim();
  return {
    icao24: row.icao24.toLowerCase(),
    callsign,
    originCountry: cleanCode(row.origin_country),
    longitude: finiteNumber(row.longitude),
    latitude: finiteNumber(row.latitude),
    baroAltitude: finiteNumber(row.baro_altitude),
    geoAltitude: finiteNumber(row.geo_altitude),
    onGround: row.on_ground === true,
    velocity: finiteNumber(row.velocity),
    trueTrack: finiteNumber(row.true_track),
    verticalRate: finiteNumber(row.vertical_rate),
    squawk: cleanCode(row.squawk),
    lastContact: finiteNumber(row.last_contact),
    category: null,
    airlineName: prefix ? airlineNames.get(prefix) ?? null : null,
  };
}

async function fetchSupabaseSnapshot(): Promise<FlightsResponse | null> {
  const config = supabaseConfig();
  if (!config) return null;

  const [rows, airlineNames] = await Promise.all([
    supabaseSelect<SupabaseFlightRow>("live_flights", {
      select:
        "icao24,callsign,origin_country,longitude,latitude,baro_altitude,geo_altitude,on_ground,velocity,true_track,vertical_rate,squawk,last_contact,position_source,updated_at",
      order: "updated_at.desc",
      limit: "1000",
    }),
    getAirlineNames(),
  ]);
  if (rows.length === 0) return null;

  const fetchedAt = new Date(
    Math.max(...rows.map((row) => Date.parse(row.updated_at)).filter(Number.isFinite)),
  );
  const age = Date.now() - fetchedAt.getTime();
  if (!Number.isFinite(fetchedAt.getTime()) || age > STALE_CACHE_MAX_MS) {
    return null;
  }
  return {
    flights: rows.map((row) => flightFromSupabase(row, airlineNames)),
    fetchedAt,
    stale: age > FLIGHT_CACHE_MS,
    warning: age > FLIGHT_CACHE_MS ? "Supabase flight data is delayed." : null,
  };
}

async function refreshFlights(): Promise<FlightsResponse> {
  let supabaseWarning: string | null = null;
  try {
    const stored = await fetchSupabaseSnapshot();
    if (stored) return stored;
    if (supabaseConfig()) {
      supabaseWarning =
        "Supabase has no recent flight snapshot; showing the direct OpenSky feed.";
    }
  } catch (error) {
    supabaseWarning =
      "Supabase is unavailable; showing the direct OpenSky feed.";
    logger.warn({ err: error }, "Supabase flight data unavailable");
  }

  return fetchOpenSkySnapshot(supabaseWarning);
}

export async function getFlightsSnapshot(): Promise<FlightsResponse> {
  if (flightCache && Date.now() - flightCache.cachedAt < FLIGHT_CACHE_MS) {
    return flightCache.data;
  }
  if (pendingFlightRefresh) return pendingFlightRefresh;

  pendingFlightRefresh = refreshFlights()
    .then((data) => {
      flightCache = { data, cachedAt: Date.now() };
      return data;
    })
    .catch((error: unknown) => {
      logger.warn({ err: error }, "Live flight refresh failed");
      if (
        flightCache &&
        Date.now() - flightCache.cachedAt < STALE_CACHE_MAX_MS
      ) {
        return {
          ...flightCache.data,
          stale: true,
          warning: "Live data refresh failed; showing the last successful snapshot.",
        };
      }
      throw error;
    })
    .finally(() => {
      pendingFlightRefresh = undefined;
    });

  return pendingFlightRefresh;
}

function airportFromSupabase(row: SupabaseAirportRow): Airport {
  return {
    airportId: row.airport_id,
    name: row.name,
    city: cleanCode(row.city),
    country: row.country,
    iataCode: cleanCode(row.iata_code),
    icaoCode: cleanCode(row.icao_code),
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: finiteNumber(row.altitude),
    timezone: finiteNumber(row.timezone),
    tzDatabase: cleanCode(row.tz_database),
    type: cleanCode(row.type),
  };
}

function airportFromCsv(row: string[]): Airport | null {
  const airportId = Number(row[0]);
  const latitude = Number(row[6]);
  const longitude = Number(row[7]);
  const country = cleanCode(row[3]);
  if (
    !Number.isInteger(airportId) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    country !== "South Africa"
  ) {
    return null;
  }
  const airport: Airport = {
    airportId,
    name: cleanCode(row[1]) ?? "Unknown airport",
    city: cleanCode(row[2]),
    country,
    iataCode: cleanCode(row[4]),
    icaoCode: cleanCode(row[5]),
    latitude,
    longitude,
    altitude: finiteNumber(Number(row[8])),
    timezone: finiteNumber(Number(row[9])),
    tzDatabase: cleanCode(row[11]),
    type: cleanCode(row[12]),
  };
  return airport.iataCode || airport.icaoCode ? airport : null;
}

async function loadAirports(): Promise<Airport[]> {
  try {
    const rows = await supabaseSelect<SupabaseAirportRow>("airports", {
      select:
        "airport_id,name,city,country,iata_code,icao_code,latitude,longitude,altitude,timezone,tz_database,type",
      country: "eq.South Africa",
      order: "city.asc",
      limit: "300",
    });
    if (rows.length > 0) return rows.map(airportFromSupabase);
  } catch (error) {
    logger.warn({ err: error }, "Supabase airports unavailable; using OpenFlights");
  }

  return csvRows(await fetchText(AIRPORTS_URL))
    .map(airportFromCsv)
    .filter((airport): airport is Airport => airport !== null)
    .sort((a, b) => (a.city ?? a.name).localeCompare(b.city ?? b.name));
}

export async function getSouthAfricanAirports(): Promise<Airport[]> {
  if (
    airportsCache &&
    Date.now() - airportsCache.cachedAt < REFERENCE_CACHE_MS
  ) {
    return airportsCache.data;
  }
  if (pendingAirportsLoad) return pendingAirportsLoad;

  pendingAirportsLoad = loadAirports()
    .then((airports) => {
      airportsCache = { data: airports, cachedAt: Date.now() };
      return airports;
    })
    .finally(() => {
      pendingAirportsLoad = undefined;
    });
  return pendingAirportsLoad;
}

function routeFromSupabase(
  row: SupabaseRouteRow,
  airlineNames: Map<string, string>,
): AirportRoute {
  const airlineCode = row.airline_code.toUpperCase();
  return {
    routeKey: row.route_key,
    airlineCode,
    airlineName: airlineNames.get(airlineCode) ?? null,
    sourceAirportCode: row.source_airport_code.toUpperCase(),
    destinationAirportCode: row.destination_airport_code.toUpperCase(),
    stops: Number.isInteger(row.stops) ? row.stops : 0,
    equipment: cleanCode(row.equipment),
  };
}

async function loadAirportRoutes(): Promise<AirportRoute[]> {
  const airports = await getSouthAfricanAirports();
  const airportCodes = [
    ...new Set(
      airports
        .flatMap((airport) => [airport.iataCode, airport.icaoCode])
        .filter(
          (code): code is string =>
            typeof code === "string" && /^[A-Z0-9]{2,4}$/i.test(code),
        )
        .map((code) => code.toUpperCase()),
    ),
  ];
  const airlineNames = await getAirlineNames();

  try {
    const codeFilter = `in.(${airportCodes.join(",")})`;
    const select = [
      "route_key",
      "airline_code",
      "source_airport_code",
      "destination_airport_code",
      "stops",
      "equipment",
    ].join(",");
    const [fromRows, toRows] = await Promise.all([
      supabaseSelect<SupabaseRouteRow>("routes", {
        select,
        source_airport_code: codeFilter,
        limit: "10000",
      }),
      supabaseSelect<SupabaseRouteRow>("routes", {
        select,
        destination_airport_code: codeFilter,
        limit: "10000",
      }),
    ]);
    const rows = new Map<string, SupabaseRouteRow>();
    for (const row of [...fromRows, ...toRows]) rows.set(row.route_key, row);
    if (rows.size > 0) {
      return [...rows.values()]
        .map((row) => routeFromSupabase(row, airlineNames))
        .sort((a, b) =>
          `${a.sourceAirportCode}-${a.destinationAirportCode}`.localeCompare(
            `${b.sourceAirportCode}-${b.destinationAirportCode}`,
          ),
        );
    }
  } catch (error) {
    logger.warn({ err: error }, "Supabase routes unavailable; using OpenFlights");
  }

  const airportCodeSet = new Set(airportCodes);
  return csvRows(await fetchText(ROUTES_URL))
    .map((row) => {
      const airlineCode = cleanCode(row[0])?.toUpperCase();
      const sourceAirportCode = cleanCode(row[2])?.toUpperCase();
      const destinationAirportCode = cleanCode(row[4])?.toUpperCase();
      if (
        !airlineCode ||
        !sourceAirportCode ||
        !destinationAirportCode ||
        (!airportCodeSet.has(sourceAirportCode) &&
          !airportCodeSet.has(destinationAirportCode))
      ) {
        return null;
      }
      const stops = finiteNumber(Number(row[7])) ?? 0;
      const equipment = cleanCode(row[8]);
      return {
        routeKey: JSON.stringify([
          airlineCode,
          sourceAirportCode,
          destinationAirportCode,
          equipment,
          stops,
        ]),
        airlineCode,
        airlineName: airlineNames.get(airlineCode) ?? null,
        sourceAirportCode,
        destinationAirportCode,
        stops,
        equipment,
      } satisfies AirportRoute;
    })
    .filter((route): route is AirportRoute => route !== null)
    .sort((a, b) =>
      `${a.sourceAirportCode}-${a.destinationAirportCode}`.localeCompare(
        `${b.sourceAirportCode}-${b.destinationAirportCode}`,
      ),
    );
}

export async function getSouthAfricanAirportRoutes(): Promise<AirportRoute[]> {
  if (
    airportRoutesCache &&
    Date.now() - airportRoutesCache.cachedAt < REFERENCE_CACHE_MS
  ) {
    return airportRoutesCache.data;
  }
  if (pendingAirportRoutesLoad) return pendingAirportRoutesLoad;

  pendingAirportRoutesLoad = loadAirportRoutes()
    .then((routes) => {
      airportRoutesCache = { data: routes, cachedAt: Date.now() };
      return routes;
    })
    .finally(() => {
      pendingAirportRoutesLoad = undefined;
    });
  return pendingAirportRoutesLoad;
}

export function summarizeFlights(snapshot: FlightsResponse) {
  const onGround = snapshot.flights.filter((flight) => flight.onGround).length;
  return {
    totalFlights: snapshot.flights.length,
    airborne: snapshot.flights.length - onGround,
    onGround,
    fetchedAt: snapshot.fetchedAt,
    stale: snapshot.stale,
  };
}
