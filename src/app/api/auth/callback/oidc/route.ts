import { getAuth } from "@/lib/auth/auth";
import { logger } from "@/lib/logger";

// Keep Better Auth's account and session APIs server-side. They act on the
// shared user record, while Logbook grants access by OIDC subject.
export async function GET(request: Request): Promise<Response> {
  try {
    return await getAuth().handler(request);
  } catch {
    logger.error("OIDC callback failed");
    return new Response(null, {
      status: 303,
      headers: { Location: "/login?error=OIDC_CALLBACK_FAILED", "Cache-Control": "no-store" },
    });
  }
}

// Better Auth also accepts a provider's form_post callback.
export const POST = GET;
