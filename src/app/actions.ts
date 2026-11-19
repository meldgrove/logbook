"use server";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/auth";
import { getOidcEndpoints } from "@/lib/auth/oidc-discovery";
import { getAuthConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { authAccount, person } from "@/lib/db/schema";
import { OIDC_PROVIDER_ID } from "@/lib/directory/sessions";
import { logger } from "@/lib/logger";

/** Starts the login at the identity provider (authorization code flow with PKCE). */
export async function signInAction(): Promise<void> {
  let url: string;
  try {
    const result = await getAuth().api.signInSocial({
      body: { provider: OIDC_PROVIDER_ID, callbackURL: "/", errorCallbackURL: "/login" },
      headers: await headers(),
    });
    if (!result.url) throw new Error("Better Auth returned no authorization URL");
    url = result.url;
  } catch {
    logger.error("Could not start OIDC sign-in");
    redirect("/login?error=OIDC_SIGN_IN_FAILED");
  }
  redirect(url);
}

/**
 * Ends the Logbook session and then the identity provider's session
 * (RP-initiated logout with `id_token_hint`), so the next login asks for
 * credentials again.
 */
export async function signOutAction(): Promise<void> {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableRefresh: true },
  }).catch(() => {
    logger.warn("Could not read the session for provider logout");
    return null;
  });
  await auth.api.signOut({ headers: requestHeaders });

  const config = getAuthConfig();
  const endSession = (await getOidcEndpoints(config.OIDC_ISSUER))?.endSessionEndpoint;
  if (!endSession) redirect("/login");
  const logoutUrl = new URL(endSession);
  logoutUrl.searchParams.set("client_id", config.OIDC_CLIENT_ID);
  logoutUrl.searchParams.set("post_logout_redirect_uri", `${config.LOGBOOK_BASE_URL}/`);
  if (session?.session.oidcPersonId) {
    // The shared Better Auth user may have several OIDC subjects. Use only
    // the token for the subject that started this Logbook session.
    try {
      const [account] = await getDb()
        .select({ idToken: authAccount.idToken })
        .from(authAccount)
        .innerJoin(person, eq(person.oidcSubject, authAccount.accountId))
        .where(and(
          eq(authAccount.providerId, OIDC_PROVIDER_ID),
          eq(authAccount.accountId, session.session.oidcSubject),
          eq(person.id, session.session.oidcPersonId),
        ));
      if (account?.idToken) logoutUrl.searchParams.set("id_token_hint", account.idToken);
    } catch {
      logger.warn("Could not read the provider logout token");
      redirect("/login");
    }
  }
  redirect(logoutUrl.toString());
}
