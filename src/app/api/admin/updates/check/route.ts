import { refuseUnlessAdmin, updatesResponse } from "@/lib/updates/http";
import { getUpdatesService } from "@/lib/updates/service";

// Asks the updater to check for updates now (up to 35 seconds). Admins only.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const refused = await refuseUnlessAdmin(request);
  if (refused) return refused;
  return updatesResponse(await getUpdatesService().check());
}
