import { refuseUnlessAdmin, updatesResponse } from "@/lib/updates/http";
import { getUpdatesService } from "@/lib/updates/service";

// The updater's status for the update button and the Updates card. Admins only.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const refused = await refuseUnlessAdmin(request);
  if (refused) return refused;
  return updatesResponse(await getUpdatesService().status());
}
