const OPENFLIGHTS_URL =
  "https://raw.githubusercontent.com/jpatokal/openflights/master/data";
const BATCH_SIZE = 500;

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.",
  );
}

function csvRows(csv) {
  const rows = [];
  let row = [];
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

function nullable(value) {
  const trimmed = value?.trim();
  return !trimmed || trimmed === "\\N" ? null : trimmed;
}

function integer(value) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimal(value) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

async function download(filename) {
  const response = await fetch(`${OPENFLIGHTS_URL}/${filename}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Downloading ${filename} failed with HTTP ${response.status}.`);
  }
  return csvRows(await response.text());
}

async function upsertBatches(table, conflictColumn, records) {
  let processed = 0;
  let nextLogAt = 1_000;

  for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
    const batch = records.slice(offset, offset + BATCH_SIZE);
    const endpoint = new URL(`${supabaseUrl}/rest/v1/${table}`);
    endpoint.searchParams.set("on_conflict", conflictColumn);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 600);
      throw new Error(
        `Upserting ${table} failed with HTTP ${response.status}: ${detail}`,
      );
    }

    processed += batch.length;
    if (processed >= nextLogAt || processed === records.length) {
      console.info(`${table}: ${processed}/${records.length} rows`);
      nextLogAt += 1_000;
    }
  }
}

function parseAirports(rows) {
  return rows
    .map((row) => ({
      airport_id: integer(row[0]),
      name: nullable(row[1]),
      city: nullable(row[2]),
      country: nullable(row[3]),
      iata_code: nullable(row[4]),
      icao_code: nullable(row[5]),
      latitude: decimal(row[6]),
      longitude: decimal(row[7]),
      altitude: integer(row[8]),
      timezone: decimal(row[9]),
      tz_database: nullable(row[11]),
      type: nullable(row[12]),
    }))
    .filter(
      (row) =>
        row.airport_id !== null &&
        row.name !== null &&
        row.country !== null &&
        row.latitude !== null &&
        row.longitude !== null,
    );
}

function parseAirlines(rows) {
  return rows
    .map((row) => ({
      airline_id: integer(row[0]),
      name: nullable(row[1]),
      iata_code: nullable(row[3]),
      icao_code: nullable(row[4]),
      callsign: nullable(row[5]),
      country: nullable(row[6]),
      active: nullable(row[7])?.toUpperCase() !== "N",
    }))
    .filter((row) => row.airline_id !== null && row.name !== null);
}

function parseRoutes(rows) {
  return rows
    .map((row) => {
      const airlineCode = nullable(row[0]);
      const sourceAirportCode = nullable(row[2]);
      const destinationAirportCode = nullable(row[4]);
      const stops = integer(row[7]);
      const equipment = nullable(row[8]);
      if (!airlineCode || !sourceAirportCode || !destinationAirportCode) {
        return null;
      }
      return {
        route_key: JSON.stringify([
          airlineCode,
          sourceAirportCode,
          destinationAirportCode,
          equipment,
          stops ?? 0,
        ]),
        airline_code: airlineCode,
        airline_id: integer(row[1]),
        source_airport_code: sourceAirportCode,
        source_airport_id: integer(row[3]),
        destination_airport_code: destinationAirportCode,
        destination_airport_id: integer(row[5]),
        codeshare: nullable(row[6])?.toUpperCase() === "Y",
        stops: stops ?? 0,
        equipment,
      };
    })
    .filter((row) => row !== null);
}

const [airportRows, airlineRows, routeRows] = await Promise.all([
  download("airports.dat"),
  download("airlines.dat"),
  download("routes.dat"),
]);

const airports = parseAirports(airportRows);
const airlines = parseAirlines(airlineRows);
const routes = parseRoutes(routeRows);

console.info(
  `Loaded ${airports.length} airports, ${airlines.length} airlines, and ${routes.length} routes.`,
);
await upsertBatches("airports", "airport_id", airports);
await upsertBatches("airlines", "airline_id", airlines);
await upsertBatches("routes", "route_key", routes);
console.info("OpenFlights reference data is ready.");
