import { createUpdatesHandler } from "@meldgrove/ui/updates/server";
import { getCurrentAdmin } from "@/lib/auth/session";
import { getAuthConfig, getUpdaterConfig, getVersionConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { isSameOrigin } from "@/lib/security/origin";

/*
 * Shared by the route handlers under /api/admin/updates. The package asks the
 * updater at UPDATER_URL with UPDATER_TOKEN and answers as the update button
 * and the Updates card expect; Logbook only decides who may ask.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function errorResponse(status: number, error: string): Response {
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

/** The four update routes; reads this process's configuration on each request. */
export const updates = createUpdatesHandler(() => {
  const { UPDATER_URL, UPDATER_TOKEN } = getUpdaterConfig();
  return {
    url: UPDATER_URL,
    token: UPDATER_TOKEN,
    appVersion: getVersionConfig().APP_VERSION ?? null,
    logger,
  };
});
