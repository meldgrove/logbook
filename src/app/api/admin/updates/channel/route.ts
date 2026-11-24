import { refuseUnlessAdmin, updates } from "@/lib/updates/http";

// Switches between the Stable and Preview channels, then checks. Admins only.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return (await refuseUnlessAdmin(request)) ?? updates.respond("channel", request);
}
