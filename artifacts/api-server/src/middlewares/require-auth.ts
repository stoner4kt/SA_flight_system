import type { RequestHandler } from "express";
import { getPublicAuthClient, SupabaseConfigError } from "../lib/supabase-admin";

export interface AuthenticatedAgent {
  id: string;
  email: string | null;
}

declare global {
  namespace Express {
    interface Locals {
      authUser?: AuthenticatedAgent;
    }
  }
}

export const requireAuth: RequestHandler = async (req, res, next): Promise<void> => {
  const authorization = req.header("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "No token provided." });
    return;
  }

  try {
    const { data, error } = await getPublicAuthClient().auth.getUser(token);
    if (error || !data.user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Invalid or expired token.",
      });
      return;
    }

    res.locals.authUser = { id: data.user.id, email: data.user.email ?? null };
    next();
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      res.status(503).json({
        error: "SUPABASE_NOT_CONFIGURED",
        message: "Authentication is unavailable until this app is connected to its Supabase project.",
      });
      return;
    }
    req.log.warn({ code: "AUTH_PROVIDER_UNAVAILABLE" }, "Supabase token validation failed");
    res.status(503).json({
      error: "AUTH_PROVIDER_UNAVAILABLE",
      message: "Authentication is temporarily unavailable.",
    });
  }
};
