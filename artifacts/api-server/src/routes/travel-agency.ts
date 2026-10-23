import {
  CreateFleetAssignmentBody,
  CreateFleetAssignmentResponse,
  CreateItineraryBody,
  CreateItineraryResponse,
  GetDashboardSummaryResponse,
  GetFleetAvailabilityQueryParams,
  GetFleetAvailabilityResponse,
  GetItineraryParams,
  GetItineraryResponse,
  ListItinerariesResponse,
  UpdateFleetTrackingStateBody,
  UpdateFleetTrackingStateParams,
  UpdateFleetTrackingStateResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/require-auth";
import {
  asDatabaseRow,
  encryptPrivateValue,
  mapFleetAssignment,
  mapFleetVehicle,
  mapItinerarySummary,
  relationRow,
  requiredText,
} from "../lib/crm-records";
import { safeDatabaseErrorCode, getAdminClient } from "../lib/supabase-admin";
import { extractSegments, sendItineraryEmail } from "../lib/travel-email";

const router: IRouter = Router();
const activeTrackingStates = new Set(["scheduled", "en_route", "arrived", "passenger_onboard"]);

function invalidRequest(res: Response, message = "Request data is invalid.") {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function reportDatabaseFailure(
  req: Request,
  res: Response,
  error: unknown,
  message: string,
): void {
  req.log.error({ code: safeDatabaseErrorCode(error) }, message);
  res.status(503).json({
    error: "TRAVEL_DATA_UNAVAILABLE",
    message: "Travel operations data is temporarily unavailable.",
  });
}

async function getItineraryDetail(id: string): Promise<Record<string, unknown> | null> {
  const db = getAdminClient();
  const { data: itinerary, error } = await db.from("itineraries").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!itinerary) return null;

  const { data: assignments, error: assignmentError } = await db
    .from("fleet_assignments")
    .select("*, fleet_vehicles(registration)")
    .eq("itinerary_id", id)
    .order("pickup_at", { ascending: true });
  if (assignmentError) throw assignmentError;

  const assignmentList = await Promise.all((assignments ?? []).map(mapFleetAssignment));
  const row = asDatabaseRow(itinerary);
  const summary = mapItinerarySummary(row, assignmentList.length);
  const segments = extractSegments(row.flight_data);
  return {
    ...summary,
    flight_data: { segments },
    fleet_assignments: assignmentList,
  };
}

router.use("/dashboard", requireAuth);
router.use("/itineraries", requireAuth);
router.use("/fleet", requireAuth);

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const db = getAdminClient();
  try {
    const [itineraryResult, assignmentResult, vehiclesResult, dsrResult, activityResult] = await Promise.all([
      db.from("itineraries").select("id", { count: "exact", head: true }),
      db.from("fleet_assignments").select("tracking_state"),
      db.from("fleet_vehicles").select("id").eq("active", true),
      db.from("popia_dsr_requests").select("id", { count: "exact", head: true }).in("status", ["pending", "verified", "processing"]),
      db.from("fleet_assignments")
        .select("id, itinerary_id, tracking_state, pickup_address, dropoff_address, updated_at, itineraries(itinerary_ref), fleet_vehicles(registration)")
        .order("updated_at", { ascending: false })
        .limit(8),
    ]);
    const failure = [itineraryResult.error, assignmentResult.error, vehiclesResult.error, dsrResult.error, activityResult.error].find(Boolean);
    if (failure) throw failure;

    const currentAssignments = (assignmentResult.data ?? []).filter((value) => {
      const state = asDatabaseRow(value).tracking_state;
      return typeof state === "string" && activeTrackingStates.has(state);
    });
    const activeVehicles = vehiclesResult.data ?? [];
    const overlapping = await db.from("fleet_assignments")
      .select("vehicle_id")
      .lt("pickup_at", new Date().toISOString())
      .gt("dropoff_at", new Date().toISOString())
      .neq("tracking_state", "cancelled");
    if (overlapping.error) throw overlapping.error;
    const occupiedVehicles = new Set((overlapping.data ?? []).map((value) => asDatabaseRow(value).vehicle_id));

    const recentActivity = (activityResult.data ?? []).map((value) => {
      const row = asDatabaseRow(value);
      const itinerary = relationRow(row, "itineraries");
      const vehicle = relationRow(row, "fleet_vehicles");
      const state = requiredText(row, "tracking_state") as "scheduled" | "en_route" | "arrived" | "passenger_onboard" | "completed" | "cancelled";
      const registration = typeof vehicle.registration === "string" ? vehicle.registration : "vehicle";
      return {
        id: requiredText(row, "id"),
        occurredAt: requiredText(row, "updated_at"),
        kind: state,
        title: `${registration} · ${state.replaceAll("_", " ")}`,
        detail: `${typeof row.pickup_address === "string" ? row.pickup_address : "Pickup"} → ${typeof row.dropoff_address === "string" ? row.dropoff_address : "Drop-off"}`,
        itineraryId: typeof row.itinerary_id === "string" ? row.itinerary_id : null,
        itineraryReference: typeof itinerary.itinerary_ref === "string" ? itinerary.itinerary_ref : null,
      };
    });
    const summary = {
      totalItineraries: itineraryResult.count ?? 0,
      activeAssignments: currentAssignments.length,
      availableVehicles: activeVehicles.filter((value) => !occupiedVehicles.has(asDatabaseRow(value).id)).length,
      pendingDsrRequests: dsrResult.count ?? 0,
      recentActivity,
    };
    res.json(GetDashboardSummaryResponse.parse(summary));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to load agency dashboard summary");
  }
});

router.get("/itineraries", async (req, res): Promise<void> => {
  const db = getAdminClient();
  try {
    const { data, error } = await db.from("itineraries").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    const itineraries = data ?? [];
    const ids = itineraries.map((value) => requiredText(asDatabaseRow(value), "id"));
    const counts = new Map<string, number>();
    if (ids.length) {
      const { data: assignmentRows, error: assignmentError } = await db
        .from("fleet_assignments")
        .select("itinerary_id")
        .in("itinerary_id", ids);
      if (assignmentError) throw assignmentError;
      for (const value of assignmentRows ?? []) {
        const id = asDatabaseRow(value).itinerary_id;
        if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    res.json(ListItinerariesResponse.parse(itineraries.map((value) => {
      const row = asDatabaseRow(value);
      return mapItinerarySummary(row, counts.get(requiredText(row, "id")) ?? 0);
    })));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to load itineraries");
  }
});

router.post("/itineraries", async (req, res): Promise<void> => {
  const parsed = CreateItineraryBody.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, "Provide a client, email address and at least one complete flight segment.");
    return;
  }

  try {
    const input = parsed.data;
    const clientPhone = input.client_phone?.replace(/\s+/g, "") ?? null;
    if (clientPhone && !/^\+\d{10,15}$/.test(clientPhone)) {
      invalidRequest(res, "Phone numbers must use international format, for example +27820000000.");
      return;
    }
    if (input.flight_segments.some((segment, index) =>
      segment.arrival_time <= segment.departure_time ||
      (index > 0 && segment.departure_time < input.flight_segments[index - 1]!.arrival_time),
    )) {
      invalidRequest(res, "Each flight must arrive after it departs, and segments cannot overlap.");
      return;
    }
    const [phone, passport, saId] = await Promise.all([
      encryptPrivateValue(clientPhone),
      encryptPrivateValue(input.passport_number),
      encryptPrivateValue(input.sa_id_number),
    ]);
    const flightData = {
      segments: input.flight_segments.map((segment) => ({
        ...segment,
        departure_time: new Date(segment.departure_time).toISOString(),
        arrival_time: new Date(segment.arrival_time).toISOString(),
      })),
    };
    const { data, error } = await getAdminClient().from("itineraries").insert({
      client_name: input.client_name.trim(),
      client_email: input.client_email.trim().toLowerCase(),
      phone_enc: phone,
      passport_enc: passport,
      sa_id_enc: saId,
      flight_data: flightData,
      status: input.status ?? "pending",
      created_by: res.locals.authUser?.id ?? null,
    }).select("id").single();
    if (error) throw error;

    const id = requiredText(asDatabaseRow(data), "id");
    const detail = await getItineraryDetail(id);
    if (!detail) {
      res.status(503).json({ error: "TRAVEL_DATA_UNAVAILABLE", message: "The booking was saved but could not be loaded." });
      return;
    }
    res.status(201).json(CreateItineraryResponse.parse(detail));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to create itinerary");
  }
});

router.get("/itineraries/:id", async (req, res): Promise<void> => {
  const parsed = GetItineraryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "NOT_FOUND", message: "Itinerary not found." });
    return;
  }
  try {
    const detail = await getItineraryDetail(parsed.data.id);
    if (!detail) {
      res.status(404).json({ error: "NOT_FOUND", message: "Itinerary not found." });
      return;
    }
    res.json(GetItineraryResponse.parse(detail));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to load itinerary");
  }
});

router.get("/fleet/availability", async (req, res): Promise<void> => {
  const raw = {
    from: new Date(String(req.query.from ?? "")),
    to: new Date(String(req.query.to ?? "")),
  };
  const parsed = GetFleetAvailabilityQueryParams.safeParse(raw);
  if (!parsed.success || !Number.isFinite(parsed.data?.from.getTime()) ||
      !Number.isFinite(parsed.data?.to.getTime()) || parsed.data.to <= parsed.data.from) {
    invalidRequest(res, "Provide a valid time range where the end is after the start.");
    return;
  }

  try {
    const db = getAdminClient();
    const [vehiclesResult, assignmentsResult] = await Promise.all([
      db.from("fleet_vehicles").select("*").eq("active", true).order("registration", { ascending: true }),
      db.from("fleet_assignments").select("*, fleet_vehicles(registration)")
        .lt("pickup_at", parsed.data.to.toISOString())
        .gt("dropoff_at", parsed.data.from.toISOString())
        .neq("tracking_state", "cancelled")
        .order("pickup_at", { ascending: true }),
    ]);
    if (vehiclesResult.error) throw vehiclesResult.error;
    if (assignmentsResult.error) throw assignmentsResult.error;
    const conflictsByVehicle = new Map<string, unknown[]>();
    for (const assignment of assignmentsResult.data ?? []) {
      const row = asDatabaseRow(assignment);
      const id = row.vehicle_id;
      if (typeof id === "string") {
        const list = conflictsByVehicle.get(id) ?? [];
        list.push(assignment);
        conflictsByVehicle.set(id, list);
      }
    }
    const result = await Promise.all((vehiclesResult.data ?? []).map(async (vehicle) => {
      const mappedVehicle = mapFleetVehicle(vehicle);
      const conflicts = await Promise.all((conflictsByVehicle.get(String(mappedVehicle.id)) ?? []).map(mapFleetAssignment));
      return { vehicle: mappedVehicle, available: conflicts.length === 0, conflicts };
    }));
    res.json(GetFleetAvailabilityResponse.parse(result));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to check fleet availability");
  }
});

router.post("/fleet/assign", async (req, res): Promise<void> => {
  const parsed = CreateFleetAssignmentBody.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, "Complete the itinerary, passenger email, driver, vehicle, pickup and drop-off details.");
    return;
  }
  const input = parsed.data;
  if (input.dropoff_at <= input.pickup_at) {
    invalidRequest(res, "Drop-off must be after pickup.");
    return;
  }
  const driverContact = input.driver_contact.replace(/\s+/g, "");
  if (!/^\+\d{10,15}$/.test(driverContact)) {
    invalidRequest(res, "Driver contact must use international format, for example +27820000000.");
    return;
  }

  const db = getAdminClient();
  try {
    const [{ data: itinerary, error: itineraryError }, { data: vehicle, error: vehicleError }] = await Promise.all([
      db.from("itineraries").select("*").eq("id", input.itinerary_id).maybeSingle(),
      db.from("fleet_vehicles").select("*").eq("id", input.vehicle_id).eq("active", true).maybeSingle(),
    ]);
    if (itineraryError) throw itineraryError;
    if (vehicleError) throw vehicleError;
    if (!itinerary) {
      res.status(404).json({ error: "NOT_FOUND", message: "Itinerary not found." });
      return;
    }
    if (!vehicle) {
      res.status(404).json({ error: "VEHICLE_NOT_FOUND", message: "Choose an active vehicle." });
      return;
    }

    const itineraryRow = asDatabaseRow(itinerary);
    const itineraryEmail = requiredText(itineraryRow, "client_email");
    if (itineraryEmail.toLowerCase() !== input.client_email.trim().toLowerCase()) {
      invalidRequest(res, "The passenger email must match the itinerary.");
      return;
    }

    const driverContactEncrypted = await encryptPrivateValue(driverContact);
    const { data: created, error: insertError } = await db.from("fleet_assignments").insert({
      itinerary_id: input.itinerary_id,
      vehicle_id: input.vehicle_id,
      driver_name: input.driver_name.trim(),
      driver_contact_enc: driverContactEncrypted,
      pickup_at: input.pickup_at.toISOString(),
      dropoff_at: input.dropoff_at.toISOString(),
      pickup_address: input.pickup_address.trim(),
      dropoff_address: input.dropoff_address.trim(),
      notes: input.notes?.trim() || null,
      assigned_by: res.locals.authUser?.id ?? null,
      notification_owner: "api",
    }).select("*, fleet_vehicles(registration, make_model)").single();

    if (insertError) {
      if (insertError.code === "23P01") {
        res.status(409).json({
          error: "DOUBLE_BOOKING",
          message: "That vehicle is already assigned during this time. Choose another vehicle or time.",
        });
        return;
      }
      throw insertError;
    }

    const assignment = await mapFleetAssignment(created);
    let notification = { sent: false, message: "The transfer was saved, but notification status is unavailable." };
    try {
      notification = await sendItineraryEmail({
        id: requiredText(itineraryRow, "id"),
        itinerary_ref: requiredText(itineraryRow, "itinerary_ref"),
        client_name: requiredText(itineraryRow, "client_name"),
        client_email: itineraryEmail,
        flight_data: itineraryRow.flight_data,
      }, {
        id: requiredText(asDatabaseRow(created), "id"),
        driver_name: input.driver_name.trim(),
        driver_contact: driverContact,
        pickup_at: input.pickup_at.toISOString(),
        dropoff_at: input.dropoff_at.toISOString(),
        pickup_address: input.pickup_address.trim(),
        dropoff_address: input.dropoff_address.trim(),
        fleet_vehicles: {
          registration: requiredText(asDatabaseRow(vehicle), "registration"),
          make_model: requiredText(asDatabaseRow(vehicle), "make_model"),
        },
      });
    } catch {
      notification = { sent: false, message: "The transfer was saved, but the confirmation email could not be sent." };
    }

    res.status(201).json(CreateFleetAssignmentResponse.parse({
      assignment,
      notification_sent: notification.sent,
      notification_message: notification.message,
    }));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to create fleet assignment");
  }
});

router.patch("/fleet/assignments/:id/tracking-state", async (req, res): Promise<void> => {
  const params = UpdateFleetTrackingStateParams.safeParse(req.params);
  const body = UpdateFleetTrackingStateBody.safeParse(req.body);
  if (!params.success || !body.success) {
    invalidRequest(res, "Choose a valid transfer tracking state.");
    return;
  }
  try {
    const { data, error } = await getAdminClient().from("fleet_assignments")
      .update({ tracking_state: body.data.tracking_state })
      .eq("id", params.data.id)
      .select("*, fleet_vehicles(registration)")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "NOT_FOUND", message: "Fleet assignment not found." });
      return;
    }
    res.json(UpdateFleetTrackingStateResponse.parse(await mapFleetAssignment(data)));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to update transfer tracking state");
  }
});

export default router;
