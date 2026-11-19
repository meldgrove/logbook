import { errorResponse, readBody, refuseUnlessAdmin, updatesResponse } from "@/lib/updates/http";
import { getUpdatesService } from "@/lib/updates/service";
import { channelRequestSchema } from "@/lib/updates/types";

// Switches between the Stable and Preview channels, then checks. Admins only.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const refused = await refuseUnlessAdmin(request);
  if (refused) return refused;
  const body = await readBody(request, channelRequestSchema);
  if (!body) return errorResponse(400, 'Send {"channel": "stable"} or {"channel": "preview"}.');
  return updatesResponse(await getUpdatesService().channel(body.channel));
}
