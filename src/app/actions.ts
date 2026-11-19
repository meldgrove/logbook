"use server";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/auth";
import { getAuthConfig } from "@/lib/config";
import { getOidcEndpoints } from "@/lib/auth/oidc-discovery";
import { getDb } from "@/lib/db/client";
import { authAccount } from "@/lib/db/schema";
import { OIDC_PROVIDER_ID } from "@/lib/directory/sessions";

/** Starts the login at the identity provider (authorization code flow with PKCE). */
export async function signInAction(): Promise<void> {
  const result = await getAuth().api.signInSocial({
    body: { provider: OIDC_PROVIDER_ID, callbackURL: "/", errorCallbackURL: "/login" },
    headers: await headers(),
  });
  if (!result.url) throw new Error("Better Auth returned no authorization URL");
  redirect(result.url);
}

/**
 * Ends the Logbook session and then the identity provider's session
 * (RP-initiated logout with `id_token_hint`), so the next login asks for
 * credentials again.
 */
export async function signOutAction(): Promise<void> {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (session) await auth.api.signOut({ headers: requestHeaders });

  const config = getAuthConfig();
  const endSession = (await getOidcEndpoints(config.OIDC_ISSUER))?.endSessionEndpoint;
  if (!endSession) redirect("/login");
  const logoutUrl = new URL(endSession);
  logoutUrl.searchParams.set("client_id", config.OIDC_CLIENT_ID);
  logoutUrl.searchParams.set("post_logout_redirect_uri", `${config.LOGBOOK_BASE_URL}/`);
  if (session) {
    // The shared Better Auth user may have several OIDC subjects. Use only
    // the token for the subject that started this Logbook session.
    const [account] = await getDb()
      .select({ idToken: authAccount.idToken })
      .from(authAccount)
      .where(and(eq(authAccount.providerId, OIDC_PROVIDER_ID), eq(authAccount.accountId, session.session.oidcSubject)));
    if (account?.idToken) logoutUrl.searchParams.set("id_token_hint", account.idToken);
  }
  redirect(logoutUrl.toString());
}
