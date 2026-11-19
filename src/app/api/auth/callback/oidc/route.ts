import { getAuth } from "@/lib/auth/auth";

// Keep Better Auth's account and session APIs server-side. They act on the
// shared user record, while Logbook grants access by OIDC subject.
export function GET(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

// Better Auth also accepts a provider's form_post callback.
export const POST = GET;
