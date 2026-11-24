import { describe, expect, it } from "vitest";
import {
  ConfigError,
  parseAuthConfig,
  parseDirectoryConfig,
  parseErrorReportingConfig,
  movedVariables,
  parseNotificationConfig,
  parseSealingConfig,
  parseUpdaterConfig,
  parseVersionConfig,
  validateWebConfig,
  validateWorkerConfig,
} from "./config";

const auth = {
  LOGBOOK_BASE_URL: "https://logbook.example.org/",
  BETTER_AUTH_SECRET: "x".repeat(32),
  OIDC_ISSUER: "https://auth.example.org/realms/acme/",
  OIDC_CLIENT_ID: "logbook",
  OIDC_CLIENT_SECRET: "secret",
};

const keycloakDirectory = {
  DIRECTORY: "keycloak",
  OIDC_ISSUER: "https://auth.example.org/realms/acme",
  OIDC_CLIENT_ID: "logbook",
  OIDC_CLIENT_SECRET: "secret",
  KEYCLOAK_ACCESS_GROUP: "/logbook",
  KEYCLOAK_ADMIN_GROUP: "/logbook-admins",
  KEYCLOAK_TEAMS_GROUP: "/teams",
};

const manualDirectory = { INITIAL_ADMIN_EMAILS: "owner@example.org" };

describe("parseAuthConfig", () => {
  it("strips trailing slashes from URLs and defaults the scopes", () => {
    const config = parseAuthConfig(auth);
    expect(config.LOGBOOK_BASE_URL).toBe("https://logbook.example.org");
    expect(config.OIDC_ISSUER).toBe("https://auth.example.org/realms/acme");
    expect(config.OIDC_SCOPES).toBe("openid profile email");
  });

  it("treats blank values as missing", () => {
    expect(() => parseAuthConfig({ ...auth, OIDC_CLIENT_SECRET: "  " })).toThrow(/OIDC_CLIENT_SECRET/);
  });

  it("accepts the previous base URL variable for web and worker", () => {
    const legacy = { LOGBUCH_BASE_URL: "https://existing.example.org/" };
    const config = { ...auth, ...legacy, LOGBOOK_BASE_URL: " " };
    expect(parseAuthConfig(config).LOGBOOK_BASE_URL).toBe("https://existing.example.org");
    expect(parseNotificationConfig(legacy).LOGBOOK_BASE_URL).toBe("https://existing.example.org");
    expect(parseAuthConfig({ ...auth, ...legacy }).LOGBOOK_BASE_URL).toBe("https://logbook.example.org");
  });

  it("requires a long secret, and not the example one in production", () => {
    expect(() => parseAuthConfig({ ...auth, BETTER_AUTH_SECRET: "short" })).toThrow(/at least 32/);
    const example = { ...auth, BETTER_AUTH_SECRET: "development-secret-development-secret" };
    expect(() => parseAuthConfig(example)).not.toThrow();
    expect(() => parseAuthConfig({ ...example, NODE_ENV: "production" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("has no default identity provider", () => {
    expect(() => parseAuthConfig({ ...auth, OIDC_ISSUER: undefined })).toThrow(/OIDC_ISSUER/);
  });

  it("trusts the provider's email addresses only when told to", () => {
    expect(parseAuthConfig(auth).OIDC_TRUST_EMAIL).toBe(false);
    expect(parseAuthConfig({ ...auth, OIDC_TRUST_EMAIL: "true" }).OIDC_TRUST_EMAIL).toBe(true);
    expect(parseAuthConfig({ ...auth, OIDC_TRUST_EMAIL: " " }).OIDC_TRUST_EMAIL).toBe(false);
    expect(() => parseAuthConfig({ ...auth, OIDC_TRUST_EMAIL: "yes" })).toThrow(/OIDC_TRUST_EMAIL/);
  });
});

describe("parseDirectoryConfig", () => {
  it("is manual by default and needs the first admins, or nobody could ever get in", () => {
    expect(() => parseDirectoryConfig({})).toThrow(/INITIAL_ADMIN_EMAILS: is required with DIRECTORY=manual/);
    expect(() => parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: " , " })).toThrow(/INITIAL_ADMIN_EMAILS/);
    expect(parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: "Ada@Example.org, bob@example.org;carl@example.org" })).toEqual({
      DIRECTORY: "manual",
      INITIAL_ADMIN_EMAILS: ["ada@example.org", "bob@example.org", "carl@example.org"],
    });
    expect(() => parseDirectoryConfig({ INITIAL_ADMIN_EMAILS: "not-an-email" })).toThrow(/INITIAL_ADMIN_EMAILS/);
  });

  it("uses the login client for the Keycloak directory unless it has its own", () => {
    expect(parseDirectoryConfig(keycloakDirectory)).toMatchObject({
      DIRECTORY: "keycloak",
      KEYCLOAK_CLIENT_ID: "logbook",
      KEYCLOAK_CLIENT_SECRET: "secret",
      KEYCLOAK_ACCESS_GROUP: "/logbook",
    });
    expect(
      parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_CLIENT_ID: "logbook-directory", KEYCLOAK_CLIENT_SECRET: "other" }),
    ).toMatchObject({ KEYCLOAK_CLIENT_ID: "logbook-directory", KEYCLOAK_CLIENT_SECRET: "other" });
  });

  it("requires a Keycloak realm URL and all three group paths", () => {
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, OIDC_ISSUER: "https://accounts.example.org" })).toThrow(/realms/);
    for (const name of ["KEYCLOAK_ACCESS_GROUP", "KEYCLOAK_ADMIN_GROUP", "KEYCLOAK_TEAMS_GROUP"]) {
      expect(() => parseDirectoryConfig({ ...keycloakDirectory, [name]: "" }), name).toThrow(name);
    }
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_ACCESS_GROUP: "logbook" })).toThrow(/group path/);
    expect(() => parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_TEAMS_GROUP: "/org/teams/" })).toThrow(/group path/);
    expect(parseDirectoryConfig({ ...keycloakDirectory, KEYCLOAK_TEAMS_GROUP: "/org/teams" })).toMatchObject({
      KEYCLOAK_TEAMS_GROUP: "/org/teams",
    });
  });

  it("rejects an unknown directory", () => {
    expect(() => parseDirectoryConfig({ DIRECTORY: "ldap" })).toThrow(/DIRECTORY/);
  });
});

describe("validateWebConfig", () => {
  it("reports every missing variable at once", () => {
    let error: unknown;
    try {
      validateWebConfig({});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as Error).message;
    for (const name of ["DATABASE_URL", "LOGBOOK_BASE_URL", "BETTER_AUTH_SECRET", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "INITIAL_ADMIN_EMAILS"]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain("KEYCLOAK");
    expect(message).toContain("- OIDC_ISSUER: is required");
    expect(message).not.toContain("received undefined");
  });

  it("passes with a complete configuration", () => {
    expect(() => validateWebConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbook", ...auth, ...manualDirectory })).not.toThrow();
    expect(() => validateWebConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbook", ...auth, ...keycloakDirectory })).not.toThrow();
  });
});

describe("parseNotificationConfig", () => {
  const base = { LOGBOOK_BASE_URL: "https://logbook.example.org/" };

  it("sends for real in production and only logs elsewhere", () => {
    expect(parseNotificationConfig({ ...base, NODE_ENV: "production" }).NOTIFICATION_TRANSPORT).toBe("live");
    expect(parseNotificationConfig({ ...base, NODE_ENV: "development" }).NOTIFICATION_TRANSPORT).toBe("console");
    expect(parseNotificationConfig({ ...base, NODE_ENV: "production", NOTIFICATION_TRANSPORT: "console" }).NOTIFICATION_TRANSPORT).toBe("console");
  });

  it("does not read Slack, email, or the webhook: they moved to Admin › Integrations", () => {
    const config = parseNotificationConfig({ ...base, SLACK_BOT_TOKEN: "xoxp-not-checked", SMTP_URL: "not-a-url", MAIL_FROM: "x" });
    expect(config).toEqual({ NOTIFICATION_TRANSPORT: "console", LOGBOOK_BASE_URL: "https://logbook.example.org" });
  });
});

describe("movedVariables", () => {
  it("returns the old variables that are set, trimmed, and treats blank as unset", () => {
    expect(
      movedVariables({ SLACK_BOT_TOKEN: " xoxb-1 ", SMTP_URL: " ", MAIL_FROM: "", WEBHOOK_SECRET: "s".repeat(16), OIDC_CLIENT_ID: "x" }),
    ).toEqual({ SLACK_BOT_TOKEN: "xoxb-1", WEBHOOK_SECRET: "s".repeat(16) });
  });
});

describe("parseSealingConfig", () => {
  it("leaves BETTER_AUTH_SECRET optional outside the web process, but long when set", () => {
    expect(parseSealingConfig({}).BETTER_AUTH_SECRET).toBeUndefined();
    expect(parseSealingConfig({ BETTER_AUTH_SECRET: " " }).BETTER_AUTH_SECRET).toBeUndefined();
    expect(() => parseSealingConfig({ BETTER_AUTH_SECRET: "short" })).toThrow(/at least 32/);
  });
});

describe("validateWorkerConfig", () => {
  it("needs the base URL for links in messages", () => {
    expect(() => validateWorkerConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbook", ...manualDirectory })).toThrow(/LOGBOOK_BASE_URL/);
    expect(() =>
      validateWorkerConfig({ DATABASE_URL: "postgres://u:p@db:5432/logbook", LOGBOOK_BASE_URL: "https://logbook.example.org", ...manualDirectory }),
    ).not.toThrow();
  });

  it("starts with the variables an earlier compose.yaml passes: no BETTER_AUTH_SECRET, old values that are not checked", () => {
    expect(() =>
      validateWorkerConfig({
        DATABASE_URL: "postgres://u:p@db:5432/logbook",
        LOGBOOK_BASE_URL: "https://logbook.example.org",
        ...manualDirectory,
        SLACK_BOT_TOKEN: "xoxb-1",
        SLACK_CHANNEL_ID: "#not-an-id",
        SMTP_URL: "smtp://mail.example.org",
        MAIL_FROM: "logbook@example.org",
        MAIL_FROM_NAME: "",
        WEBHOOK_URL: "https://hooks.example.org/logbook",
        WEBHOOK_SECRET: "short",
      }),
    ).not.toThrow();
  });
});

describe("parseVersionConfig", () => {
  it("has no version in images built from source", () => {
    expect(parseVersionConfig({ APP_VERSION: "" }).APP_VERSION).toBeUndefined();
    expect(parseVersionConfig({ APP_VERSION: "0.2.0" }).APP_VERSION).toBe("0.2.0");
  });
});

describe("parseErrorReportingConfig", () => {
  it("is off without a DSN and rejects a DSN that is not a URL", () => {
    expect(parseErrorReportingConfig({ SENTRY_DSN: " " }).SENTRY_DSN).toBeUndefined();
    expect(parseErrorReportingConfig({ SENTRY_DSN: "https://key@o1.ingest.example.org/2" }).SENTRY_DSN).toBe(
      "https://key@o1.ingest.example.org/2",
    );
    expect(() => parseErrorReportingConfig({ SENTRY_DSN: "key@o1" })).toThrow(/SENTRY_DSN/);
    expect(() => validateWorkerConfig({ SENTRY_DSN: "key@o1" })).toThrow(/SENTRY_DSN/);
  });
});

describe("parseUpdaterConfig", () => {
  it("defaults to the updater service of compose.yaml", () => {
    expect(parseUpdaterConfig({}).UPDATER_URL).toBe("http://updater:8080");
  });

  it("switches the update button off with an empty value", () => {
    expect(parseUpdaterConfig({ UPDATER_URL: "" }).UPDATER_URL).toBeNull();
    expect(parseUpdaterConfig({ UPDATER_URL: "  " }).UPDATER_URL).toBeNull();
  });

  it("takes another http URL without a trailing slash", () => {
    expect(parseUpdaterConfig({ UPDATER_URL: "http://127.0.0.1:18082/" }).UPDATER_URL).toBe("http://127.0.0.1:18082");
    expect(() => parseUpdaterConfig({ UPDATER_URL: "updater:8080" })).toThrow(/UPDATER_URL/);
    expect(() => validateWebConfig({ ...auth, ...manualDirectory, DATABASE_URL: "postgres://x", UPDATER_URL: "ftp://updater" })).toThrow(
      /UPDATER_URL/,
    );
  });

  it("takes an optional token for the updater; blank means none", () => {
    expect(parseUpdaterConfig({}).UPDATER_TOKEN).toBeUndefined();
    expect(parseUpdaterConfig({ UPDATER_TOKEN: " " }).UPDATER_TOKEN).toBeUndefined();
    expect(parseUpdaterConfig({ UPDATER_TOKEN: "0123abcd" }).UPDATER_TOKEN).toBe("0123abcd");
    expect(() => parseUpdaterConfig({ UPDATER_TOKEN: "two words" })).toThrow(/UPDATER_TOKEN/);
    expect(() => validateWebConfig({ ...auth, ...manualDirectory, DATABASE_URL: "postgres://x", UPDATER_TOKEN: "tok\u00e9n" })).toThrow(
      /UPDATER_TOKEN/,
    );
  });
});
