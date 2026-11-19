import type { z } from "zod";
import { getCurrentAdmin } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/config";
import { isSameOrigin } from "@/lib/security/origin";
import type { UpdatesReply } from "./service";

/* Shared by the route handlers under /api/admin/updates. */

const NO_STORE = { "Cache-Control": "no-store" };

export function updatesResponse(reply: UpdatesReply): Response {
  return Response.json(reply.body, { status: reply.httpStatus, headers: NO_STORE });
}

export function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

/**
 * Admins with a session only; everyone else gets 404, as for the admin
 * pages. A POST must also come from Logbook's own pages (403 otherwise).
 * Returns the answer that refuses the request, or null to go on.
 */
export async function refuseUnlessAdmin(request: Request): Promise<Response | null> {
  if (!(await getCurrentAdmin())) return errorResponse(404, "Not found.");
  if (request.method !== "GET" && !isSameOrigin(request, getAuthConfig().LOGBOOK_BASE_URL)) {
    return errorResponse(403, "The request does not come from Logbook.");
  }
  return null;
}

/** The JSON body, checked with `schema`; null when it is missing, not JSON, or invalid. */
export async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T> | null> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
