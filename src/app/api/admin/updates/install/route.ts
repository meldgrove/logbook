import { refuseUnlessAdmin, updates } from "@/lib/updates/http";

// Asks the updater to install an offered version: 202 when it starts; a 5xx of the updater stays a 5xx. Admins only.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return (await refuseUnlessAdmin(request)) ?? updates.respond("install", request);
}
