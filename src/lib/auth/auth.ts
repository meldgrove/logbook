import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { DrizzleQueryError } from "drizzle-orm";
import { DatabaseError } from "pg";
import { getAuthConfig, type AuthConfig } from "@/lib/config";
import { getDb, type Database } from "@/lib/db/client";
import { authAccount, authSession, authUser, authVerification } from "@/lib/db/schema";
import { getDirectory, type Directory } from "@/lib/directory/directory";
import { OIDC_PROVIDER_ID } from "@/lib/directory/sessions";
import { logger } from "@/lib/logger";
import { admitLogin, NO_ACCESS_ERROR_CODE, type Login } from "./access";
import { discoveryUrl } from "./discovery-url";

export interface CreateAuthOptions {
  config: AuthConfig;
  directory: Directory;
  db: Database;
}

/**
 * The OIDC `sub` each login verified, by Better Auth endpoint context. The
 * OAuth callback writes the account row of that `sub` and then creates the
 * session, both in one request. The user ID alone does not say who logged in:
 * Better Auth links a new `sub` whose verified email matches an existing user
 * to that user.
 */
const loginAccounts = new WeakMap<object, { userId: string; subject: string }>();
const loginProfiles = new WeakMap<object, Omit<Login, "subject">>();

function rememberLoginAccount(context: object | null, account: { providerId: string; accountId: string; userId: string } | null) {
  if (!context || account?.providerId !== OIDC_PROVIDER_ID) return;
  loginAccounts.set(context, { userId: account.userId, subject: account.accountId });
}

function loginSubjectOf(context: object | null, userId: string): string | undefined {
  const login = context ? loginAccounts.get(context) : undefined;
  return login?.userId === userId ? login.subject : undefined;
}

function noAccessError() {
  return new APIError("FORBIDDEN", {
    code: NO_ACCESS_ERROR_CODE,
    message: "You do not have access to Logbook.",
  });
}

/**
 * Better Auth with one OpenID Connect provider (authorization code flow with
 * PKCE) as the only login. Endpoints, including logout, come from the
 * provider's discovery document. Sessions live in PostgreSQL and are read on
 * every request, so ending a session takes effect immediately.
 */
export function createAuth({ config, directory, db }: CreateAuthOptions) {
  return betterAuth({
    appName: "Logbook",
    baseURL: config.LOGBOOK_BASE_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.LOGBOOK_BASE_URL],
    database: (options: BetterAuthOptions) => {
      const adapter = drizzleAdapter(db, {
        provider: "pg",
        schema: { user: authUser, session: authSession, account: authAccount, verification: authVerification },
      })(options);
      const create: typeof adapter.create = async (input) => {
        try {
          return await adapter.create(input);
        } catch (error) {
          // A subject can move after admission. Report the expected denial
          // before Better Auth sees a query error with session parameters.
          if (error instanceof DrizzleQueryError && error.cause instanceof DatabaseError
            && error.cause.constraint === "logbook_session_person_binding") {
            throw noAccessError();
          }
          throw error;
        }
      };
      return { ...adapter, create };
    },
    emailAndPassword: { enabled: false },
    user: {
      validateUserInfo({ user, source }, context) {
        // A stored Better Auth profile can outlive an email change or belong
        // to multiple subjects. Keep the provider's claims for this login.
        if (source.oauth?.providerId === OIDC_PROVIDER_ID && typeof user.email === "string") {
          loginProfiles.set(context, {
            email: user.email,
            emailVerified: user.emailVerified === true,
            name: user.name ?? "",
          });
        }
      },
    },
    session: {
      // No cookie cache: every request checks the session in the database.
      cookieCache: { enabled: false },
      additionalFields: {
        // Set by the session hook below, never from the request.
        oidcSubject: { type: "string", required: true, input: false },
        oidcPersonId: { type: "string", required: false, input: false },
      },
    },
    // Logbook never uses the provider's access and refresh tokens, but
    // Better Auth stores them: keep them encrypted (with BETTER_AUTH_SECRET).
    // The ID token stays readable; logout sends it as `id_token_hint`.
    account: { encryptOAuthTokens: true },
    advanced: {
      cookiePrefix: "logbook",
      useSecureCookies: config.LOGBOOK_BASE_URL.startsWith("https://"),
    },
    onAPIError: { errorURL: `${config.LOGBOOK_BASE_URL}/login` },
    databaseHooks: {
      account: {
        create: { after: async (account, context) => rememberLoginAccount(context, account) },
        update: { after: async (account, context) => rememberLoginAccount(context, account) },
      },
      session: {
        create: {
          // The access rule runs before a session exists, so people without
          // access never get one. The session keeps the `sub` it logged in
          // with; without one, there is no session.
          before: async (session, context) => {
            const subject = loginSubjectOf(context, session.userId);
            const profile = context ? loginProfiles.get(context) : undefined;
            const personId = subject !== undefined && profile !== undefined
              ? await admitLogin(db, { ...profile, subject }, {
                directory,
                trustEmail: config.OIDC_TRUST_EMAIL,
              })
              : undefined;
            if (subject === undefined || !personId) {
              logger.info({ userId: session.userId }, "login denied: no access");
              throw noAccessError();
            }
            return { data: { ...session, oidcSubject: subject, oidcPersonId: personId } };
          },
        },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER_ID,
            discoveryUrl: discoveryUrl(config.OIDC_ISSUER),
            clientId: config.OIDC_CLIENT_ID,
            clientSecret: config.OIDC_CLIENT_SECRET,
            scopes: config.OIDC_SCOPES.split(/[\s,]+/).filter(Boolean),
            pkce: true,
            requireIdTokenVerification: true,
            // Logbook builds the logout URL from the session's OIDC subject.
            disableProviderLogout: true,
          },
        ],
      }),
      // Must be last: applies cookies set by auth.api calls in Server Actions.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { logbookAuth?: Auth };

export function getAuth(): Auth {
  globalForAuth.logbookAuth ??= createAuth({ config: getAuthConfig(), directory: getDirectory(), db: getDb() });
  return globalForAuth.logbookAuth;
}
