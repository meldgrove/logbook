import { refuseUnlessAdmin, updates } from "@/lib/updates/http";

// Asks the updater to check for updates now (up to 35 seconds). Admins only.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return (await refuseUnlessAdmin(request)) ?? updates.respond("check");
}
