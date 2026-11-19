import { errorResponse, readBody, refuseUnlessAdmin, updatesResponse } from "@/lib/updates/http";
import { getUpdatesService } from "@/lib/updates/service";
import { installRequestSchema } from "@/lib/updates/types";

// Asks the updater to install an offered version: 202 when it starts. Admins only.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const refused = await refuseUnlessAdmin(request);
  if (refused) return refused;
  const body = await readBody(request, installRequestSchema);
  if (!body) return errorResponse(400, 'Send {"version": "X.Y.Z"} with a version the updater offers.');
  return updatesResponse(await getUpdatesService().install(body.version));
}
