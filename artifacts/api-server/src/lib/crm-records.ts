import { getAdminClient } from "./supabase-admin";
import { extractSegments } from "./travel-email";

export type DatabaseRow = Record<string, unknown>;

export function asDatabaseRow(value: unknown): DatabaseRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as DatabaseRow)
    : {};
}

export function requiredText(row: DatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) {
    throw new Error("INVALID_DATABASE_ROW");
  }
  return value;
}

export function nullableText(row: DatabaseRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

export function relationRow(row: DatabaseRow, key: string): DatabaseRow {
  const relation = row[key];
  if (Array.isArray(relation)) return asDatabaseRow(relation[0]);
  return asDatabaseRow(relation);
}

export async function encryptPrivateValue(value: string | null | undefined): Promise<string | null> {
  const normalized = value?.trim();
  if (!normalized) return null;
  const { data, error } = await getAdminClient().rpc("popia_encrypt", {
    input_value: normalized,
  });
  if (error) throw error;
  if (typeof data !== "string" || !data) throw new Error("PII_ENCRYPTION_FAILED");
  return data;
}

export async function decryptPrivateValue(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || !value) return null;
  const { data, error } = await getAdminClient().rpc("popia_decrypt", {
    input_value: value,
  });
  if (error) throw error;
  return typeof data === "string" ? data : null;
}

export async function mapFleetAssignment(value: unknown): Promise<Record<string, unknown>> {
  const row = asDatabaseRow(value);
  const vehicle = relationRow(row, "fleet_vehicles");
  return {
    id: requiredText(row, "id"),
    itinerary_id: requiredText(row, "itinerary_id"),
    vehicle_id: requiredText(row, "vehicle_id"),
    vehicle_registration: typeof vehicle.registration === "string" ? vehicle.registration : "",
    driver_name: requiredText(row, "driver_name"),
    driver_contact: await decryptPrivateValue(row.driver_contact_enc),
    pickup_at: requiredText(row, "pickup_at"),
    dropoff_at: requiredText(row, "dropoff_at"),
    pickup_address: requiredText(row, "pickup_address"),
    dropoff_address: requiredText(row, "dropoff_address"),
    tracking_state: requiredText(row, "tracking_state"),
    created_at: requiredText(row, "created_at"),
    updated_at: requiredText(row, "updated_at"),
  };
}

export function mapFleetVehicle(value: unknown): Record<string, unknown> {
  const row = asDatabaseRow(value);
  return {
    id: requiredText(row, "id"),
    registration: requiredText(row, "registration"),
    make_model: requiredText(row, "make_model"),
    capacity: Number(row.capacity),
    active: row.active === true,
  };
}

export function itinerarySegments(value: unknown): Record<string, unknown>[] {
  return extractSegments(value).map((segment) => ({ ...segment }));
}

export function mapItinerarySummary(
  value: unknown,
  assignmentCount: number,
): Record<string, unknown> {
  const row = asDatabaseRow(value);
  const segments = itinerarySegments(row.flight_data);
  const firstSegment = segments[0];
  const lastSegment = segments.at(-1);
  return {
    id: requiredText(row, "id"),
    itinerary_ref: requiredText(row, "itinerary_ref"),
    client_name: requiredText(row, "client_name"),
    client_email: requiredText(row, "client_email"),
    status: requiredText(row, "status"),
    departure_at: typeof firstSegment?.departure_time === "string" ? firstSegment.departure_time : null,
    arrival_at: typeof lastSegment?.arrival_time === "string" ? lastSegment.arrival_time : null,
    assignment_count: assignmentCount,
    created_at: requiredText(row, "created_at"),
  };
}

export function mapDsrRequest(value: unknown): Record<string, unknown> {
  const row = asDatabaseRow(value);
  return {
    id: requiredText(row, "id"),
    subject_email: requiredText(row, "subject_email"),
    subject_name: nullableText(row, "subject_name"),
    request_type: requiredText(row, "request_type"),
    status: requiredText(row, "status"),
    created_at: requiredText(row, "created_at"),
    verified_at: nullableText(row, "verified_at"),
    completed_at: nullableText(row, "completed_at"),
    notes: nullableText(row, "notes"),
  };
}
