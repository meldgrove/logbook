import { refuseUnlessAdmin, updates } from "@/lib/updates/http";

// The updater's status for the update button and the Updates card. Admins only.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return (await refuseUnlessAdmin(request)) ?? updates.respond("status");
}
