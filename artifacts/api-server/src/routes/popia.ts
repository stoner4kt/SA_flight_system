import { createHash, randomBytes } from "node:crypto";
import {
  CreateDsrRequestBody,
  CreateDsrRequestResponse,
  ListDsrRequestsQueryParams,
  ListDsrRequestsResponse,
  UpdateDsrRequestBody,
  UpdateDsrRequestParams,
  UpdateDsrRequestResponse,
  VerifyDsrTokenParams,
  VerifyDsrTokenResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/require-auth";
import { rateLimiter } from "../middlewares/rate-limiter";
import { asDatabaseRow, mapDsrRequest, requiredText } from "../lib/crm-records";
import { getAdminClient, safeDatabaseErrorCode } from "../lib/supabase-admin";
import {
  sendDPONotification,
  sendErasureConfirmation,
  sendPOPIAVerificationEmail,
} from "../lib/travel-email";

const router: IRouter = Router();

function invalidRequest(res: Response, message = "Request data is invalid."): void {
  res.status(400).json({ error: "INVALID_REQUEST", message });
}

function reportDatabaseFailure(req: Request, res: Response, error: unknown, message: string): void {
  req.log.error({ code: safeDatabaseErrorCode(error) }, message);
  res.status(503).json({
    error: "PRIVACY_SERVICE_UNAVAILABLE",
    message: "The privacy service is temporarily unavailable.",
  });
}

function getAppBaseUrl(): string | null {
  const configured = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.hostname === "localhost" ? url.toString().replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

router.post("/popia/dsr", rateLimiter(3, 60 * 60 * 1000), async (req, res): Promise<void> => {
  const parsed = CreateDsrRequestBody.safeParse(req.body);
  if (!parsed.success) {
    invalidRequest(res, "Provide a valid email address and request type.");
    return;
  }

  const input = parsed.data;
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await getAdminClient().from("popia_dsr_requests").insert({
      subject_email: input.subject_email.trim().toLowerCase(),
      subject_name: input.subject_name?.trim() || null,
      request_type: input.request_type,
      verify_token: tokenHash,
      token_expires_at: expiresAt,
    }).select("id, subject_email, subject_name, request_type").single();
    if (error) throw error;

    const row = asDatabaseRow(data);
    const baseUrl = getAppBaseUrl();
    const emailResult = baseUrl
      ? await sendPOPIAVerificationEmail(
        requiredText(row, "subject_email"),
        typeof row.subject_name === "string" ? row.subject_name : null,
        requiredText(row, "request_type"),
        `${baseUrl}/privacy/verify/${token}`,
      )
      : { sent: false, message: "The privacy verification link cannot be sent until the application URL is configured." };
    res.status(202).json(CreateDsrRequestResponse.parse({
      ref: requiredText(row, "id"),
      verification_email_sent: emailResult.sent,
      message: emailResult.sent
        ? "Request received. Check your inbox for the verification link."
        : "Request received, but the verification email could not be sent. Contact the agency to continue.",
    }));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to create privacy request");
  }
});

router.get("/popia/verify/:token", async (req, res): Promise<void> => {
  const parsed = VerifyDsrTokenParams.safeParse(req.params);
  if (!parsed.success || !/^[a-f0-9]{64}$/i.test(parsed.data?.token ?? "")) {
    res.status(404).json({ error: "INVALID_TOKEN", message: "This verification link is invalid." });
    return;
  }

  try {
    const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex");
    const db = getAdminClient();
    const { data, error } = await db.from("popia_dsr_requests")
      .select("*")
      .eq("verify_token", tokenHash)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "INVALID_TOKEN", message: "This verification link is invalid." });
      return;
    }

    const row = asDatabaseRow(data);
    const requestId = requiredText(row, "id");
    if (typeof row.verified_at === "string") {
      res.json(VerifyDsrTokenResponse.parse({
        request_id: requestId,
        verified: true,
        message: "This request has already been verified.",
      }));
      return;
    }
    const expiry = typeof row.token_expires_at === "string" ? new Date(row.token_expires_at) : null;
    if (!expiry || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      res.status(410).json({ error: "TOKEN_EXPIRED", message: "This verification link has expired. Submit a new request." });
      return;
    }

    const verifiedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await db.from("popia_dsr_requests")
      .update({ verified_at: verifiedAt, status: "verified" })
      .eq("id", requestId)
      .is("verified_at", null)
      .select("id, subject_email, subject_name, request_type, verified_at")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) {
      res.status(409).json({ error: "ALREADY_VERIFIED", message: "This request has already been verified." });
      return;
    }

    const verifiedRow = asDatabaseRow(updated);
    const dpoEmail = process.env.POPIA_DPO_EMAIL?.trim();
    const baseUrl = getAppBaseUrl();
    const dpoResult = dpoEmail && baseUrl
      ? await sendDPONotification(
        dpoEmail,
        requiredText(verifiedRow, "request_type"),
        requiredText(verifiedRow, "subject_email"),
        typeof verifiedRow.subject_name === "string" ? verifiedRow.subject_name : null,
        `${baseUrl}/dashboard/privacy`,
      )
      : { sent: false, message: "The privacy team notification is not configured." };
    res.json(VerifyDsrTokenResponse.parse({
      request_id: requestId,
      verified: true,
      message: dpoResult.sent
        ? "Your email is verified. The privacy team has been notified."
        : "Your email is verified. The privacy team could not be notified automatically; contact the agency if you need an update.",
    }));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to verify privacy request");
  }
});

router.use(requireAuth);

router.get("/popia/dsr", async (req, res): Promise<void> => {
  const parsed = ListDsrRequestsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    invalidRequest(res, "Use a valid status, page number and page size.");
    return;
  }
  const { page, limit, status } = parsed.data;
  try {
    let query = getAdminClient().from("popia_dsr_requests")
      .select("*", { count: "exact" })
      .order("verified_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (status) query = query.eq("status", status);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json(ListDsrRequestsResponse.parse({
      items: await Promise.all((data ?? []).map(mapDsrRequest)),
      page,
      limit,
      total: count ?? 0,
    }));
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to load privacy requests");
  }
});

router.patch("/popia/dsr/:id", async (req, res): Promise<void> => {
  const params = UpdateDsrRequestParams.safeParse(req.params);
  const body = UpdateDsrRequestBody.safeParse(req.body);
  if (!params.success || !body.success) {
    invalidRequest(res, "Choose a valid privacy request status.");
    return;
  }

  const { id } = params.data;
  const { status, notes } = body.data;
  const agentId = res.locals.authUser?.id;
  try {
    const db = getAdminClient();
    const { data: existing, error: lookupError } = await db.from("popia_dsr_requests")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!existing) {
      res.status(404).json({ error: "NOT_FOUND", message: "Privacy request not found." });
      return;
    }
    const existingRow = asDatabaseRow(existing);
    const requestType = requiredText(existingRow, "request_type");
    const email = requiredText(existingRow, "subject_email");
    const name = typeof existingRow.subject_name === "string" ? existingRow.subject_name : null;
    const verifiedAt = existingRow.verified_at;
    if (status !== "rejected" && typeof verifiedAt !== "string") {
      res.status(409).json({ error: "NOT_VERIFIED", message: "The subject must verify their email before processing this request." });
      return;
    }

    let redactedCount: number | null = null;
    if (status === "completed" && requestType === "erasure") {
      const { data: count, error } = await db.rpc("popia_complete_erasure", {
        request_id: id,
        agent_id: agentId ?? null,
        agent_notes: notes ?? null,
      });
      if (error) throw error;
      redactedCount = Number(count);
      await sendErasureConfirmation(email, Number.isFinite(redactedCount) ? redactedCount : 0, id);
    } else {
      const changes: Record<string, unknown> = {
        status,
        completed_at: status === "completed" ? new Date().toISOString() : null,
        completed_by: status === "completed" ? agentId ?? null : null,
      };
      if (Object.prototype.hasOwnProperty.call(req.body, "notes")) {
        changes.notes = notes ?? null;
      }
      const { error } = await db.from("popia_dsr_requests").update(changes).eq("id", id);
      if (error) throw error;
    }

    const { data: updated, error: updatedError } = await db.from("popia_dsr_requests")
      .select("*")
      .eq("id", id)
      .single();
    if (updatedError) throw updatedError;
    res.json(UpdateDsrRequestResponse.parse({
      success: true,
      request: mapDsrRequest(updated),
    }));
    if (redactedCount !== null) {
      req.log.info({ count: redactedCount }, "Completed verified erasure request");
    }
  } catch (error) {
    reportDatabaseFailure(req, res, error, "Unable to update privacy request");
  }
});

export default router;
