import { eq } from "drizzle-orm";
import { z } from "zod";
import { auditActor, environmentImport } from "@/lib/audit/actor";
import { recordAudit } from "@/lib/audit";
import { MOVED_VARIABLES, movedVariables, type MovedVariable } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import { appSetting } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { seal, secretHint, type SealingKey } from "./crypto";
import { INPUT_SCHEMAS, mailerSendInputSchema, smtpInputSchema, type IntegrationName, type SmtpSecurity } from "./schemas";
import { changedFields, MOVED_TO } from "./service";
import { EMPTY, loadStored, lockIntegrations, SECRET_FIELDS, writeStored, type Integrations, type StoredIntegrations } from "./store";

/*
 * Versions before Admin › Integrations read Slack, email, and the webhook
 * from the environment (MOVED_VARIABLES in config.ts). Every process that
 * starts (web, worker, migrate) copies the ones it sees into the database
 * once, into fields that are still empty, with the page's checks, and
 * remembers each variable in `app_setting` (`moved_variables`): a remembered
 * variable is never read again, also after an admin clears the field.
 * Processes that start together wait for each other on a lock.
 *
 * A worker started with an older compose.yaml has no BETTER_AUTH_SECRET: it
 * cannot seal what it would copy, so it copies nothing and sends with the
 * variables, as before (`settingsFromEnvironment`).
 */

const RECORD_KEY = "moved_variables";
type Outcome = "copied" | "kept" | "refused";

export interface ImportResult {
  /** Copied into an empty field. */
  copied: MovedVariable[];
  /** The field had a value: the database wins. */
  kept: MovedVariable[];
  /** The page would refuse the value; the field stays as it was. */
  refused: MovedVariable[];
  /** Not copied yet: this process has no BETTER_AUTH_SECRET. */
  waiting: MovedVariable[];
}

interface Smtp {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string | null;
}

/**
 * An old SMTP_URL as the page's fields: smtps:// is TLS (465); smtp:// (587)
 * keeps nodemailer's behavior: STARTTLS when the server offers it (`auto`),
 * required with `requireTLS=true`, never with `ignoreTLS=true`.
 */
export function smtpFromUrl(value: string): Smtp | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return undefined;
  const tls = url.protocol === "smtps:";
  const decode = (part: string) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const smtp = {
    host: url.hostname,
    port: url.port ? Number(url.port) : tls ? 465 : 587,
    security: (tls
      ? "tls"
      : url.searchParams.get("ignoreTLS") === "true"
        ? "none"
        : url.searchParams.get("requireTLS") === "true"
          ? "starttls"
          : "auto") as SmtpSecurity,
    username: decode(url.username),
    password: url.password ? decode(url.password) : null,
  };
  const checked = smtpInputSchema.safeParse({ ...smtp, password: smtp.password ?? undefined });
  return checked.success && smtp.host ? smtp : undefined;
}

/** A value as the page's field would take it, or undefined when the page would refuse it. */
const accepted = <T>(schema: z.ZodType<T>, value: string): T | undefined => {
  const parsed = schema.safeParse(value);
  return parsed.success && parsed.data !== undefined && parsed.data !== null ? parsed.data : undefined;
};

/**
 * How each variable maps to a field: `read` checks the value as the page
 * would, `isSet` says whether the database already has the field, `copy`
 * writes it into the stored settings (sealing secrets), and `use` into the
 * settings of a worker without the key.
 */
const RULES: {
  [V in MovedVariable]: {
    read(value: string): unknown;
    isSet(stored: StoredIntegrations): boolean;
    copy(stored: StoredIntegrations, value: never, key: SealingKey): void;
    use(settings: Integrations, value: never): void;
  };
} = {
  SLACK_BOT_TOKEN: {
    read: (value) => accepted(INPUT_SCHEMAS.slack.shape.botToken, value),
    isSet: (stored) => stored.slack.botToken !== null,
    copy: (stored, value: string, key) => {
      stored.slack.botToken = { sealed: seal(key, SECRET_FIELDS.slackBotToken, value), hint: secretHint(value) };
    },
    use: (settings, value: string) => {
      settings.slack.botToken = value;
    },
  },
  SLACK_CHANNEL_ID: {
    read: (value) => accepted(INPUT_SCHEMAS.slack.shape.channelId, value),
    isSet: (stored) => stored.slack.channelId !== null,
    copy: (stored, value: string) => {
      stored.slack.channelId = value;
    },
    use: (settings, value: string) => {
      settings.slack.channelId = value;
    },
  },
  SMTP_URL: {
    read: smtpFromUrl,
    isSet: (stored) => stored.email.smtp.host !== "",
    copy: (stored, value: Smtp, key) => {
      const password = value.password ? { sealed: seal(key, SECRET_FIELDS.smtpPassword, value.password), hint: secretHint(value.password) } : null;
      stored.email.smtp = { ...value, password };
      if (stored.email.provider === "none") stored.email.provider = "smtp";
    },
    use: (settings, value: Smtp) => {
      settings.email.smtp = value;
      settings.email.provider = "smtp";
    },
  },
  MAILERSEND_API_TOKEN: {
    read: (value) => accepted(mailerSendInputSchema.shape.token, value),
    isSet: (stored) => stored.email.mailersend.token !== null,
    copy: (stored, value: string, key) => {
      stored.email.mailersend.token = { sealed: seal(key, SECRET_FIELDS.mailerSendToken, value), hint: secretHint(value) };
      if (stored.email.provider === "none") stored.email.provider = "mailersend";
    },
    use: (settings, value: string) => {
      settings.email.mailersendToken = value;
      // SMTP_URL and MAILERSEND_API_TOKEN were never allowed together.
      if (settings.email.provider === "none") settings.email.provider = "mailersend";
    },
  },
  MAIL_FROM: {
    read: (value) => accepted(z.email().max(320), value),
    isSet: (stored) => stored.email.fromAddress !== "",
    copy: (stored, value: string) => {
      stored.email.fromAddress = value;
    },
    use: (settings, value: string) => {
      settings.email.fromAddress = value;
    },
  },
  MAIL_FROM_NAME: {
    read: (value) => accepted(INPUT_SCHEMAS.email.shape.fromName, value),
    isSet: (stored) => stored.email.fromName !== "",
    copy: (stored, value: string) => {
      stored.email.fromName = value;
    },
    use: (settings, value: string) => {
      settings.email.fromName = value;
    },
  },
  WEBHOOK_URL: {
    read: (value) => accepted(INPUT_SCHEMAS.webhook.shape.url, value),
    isSet: (stored) => stored.webhook.url !== null,
    copy: (stored, value: string) => {
      stored.webhook.url = value;
    },
    use: (settings, value: string) => {
      settings.webhook.url = value;
    },
  },
  WEBHOOK_SECRET: {
    read: (value) => accepted(INPUT_SCHEMAS.webhook.shape.secret, value),
    isSet: (stored) => stored.webhook.secret !== null,
    copy: (stored, value: string, key) => {
      stored.webhook.secret = { sealed: seal(key, SECRET_FIELDS.webhookSecret, value), hint: secretHint(value) };
    },
    use: (settings, value: string) => {
      settings.webhook.secret = value;
    },
  },
};

type Rule = { read(value: string): unknown; isSet(stored: StoredIntegrations): boolean; copy(stored: StoredIntegrations, value: unknown, key: SealingKey): void; use(settings: Integrations, value: unknown): void };
const rule = (name: MovedVariable) => RULES[name] as unknown as Rule;

const recordSchema = z.object({ variables: z.record(z.string(), z.enum(["copied", "kept", "refused"])) }).catch({ variables: {} });

/**
 * Copies the moved variables this process sees into the database, each once
 * (see above). Returns what happened to each, by name only.
 */
export async function importMovedVariables(
  db: Database,
  options: { env?: Record<string, string | undefined>; key: SealingKey | null },
): Promise<ImportResult> {
  const result: ImportResult = { copied: [], kept: [], refused: [], waiting: [] };
  const values = movedVariables(options.env);
  const given = MOVED_VARIABLES.filter((name) => values[name] !== undefined);
  if (given.length === 0) return result;
  const key = options.key;
  if (!key) {
    result.waiting.push(...given);
    return result;
  }
  await db.transaction(async (tx) => {
    await lockIntegrations(tx);
    const [row] = await tx.select({ value: appSetting.value }).from(appSetting).where(eq(appSetting.key, RECORD_KEY));
    // A copy: the schema's fallback is one shared object.
    const done: Record<string, Outcome> = { ...recordSchema.parse(row?.value).variables };
    const pending = given.filter((name) => !(name in done));
    if (pending.length === 0) return;

    const { stored } = await loadStored(tx);
    const next = structuredClone(stored);
    const copied = new Map<IntegrationName, MovedVariable[]>();
    for (const name of pending) {
      const { read, isSet, copy } = rule(name);
      let outcome: Outcome;
      if (isSet(next)) {
        outcome = "kept";
      } else {
        const value = read(values[name]!);
        if (value === undefined) {
          outcome = "refused";
        } else {
          copy(next, value, key);
          outcome = "copied";
          copied.set(MOVED_TO[name], [...(copied.get(MOVED_TO[name]) ?? []), name]);
        }
      }
      result[outcome].push(name);
      done[name] = outcome;
    }
    for (const [setting, names] of copied) {
      await writeStored(tx, setting, next[setting] as never, null);
      const { payload } = auditActor(environmentImport(names));
      await recordAudit(tx, { actorId: null, action: `settings.${setting}_changed`, payload: { ...payload, changed: changedFields(stored[setting], next[setting]) } });
    }
    await tx
      .insert(appSetting)
      .values({ key: RECORD_KEY, value: { variables: done } })
      .onConflictDoUpdate({ target: appSetting.key, set: { value: { variables: done }, updatedAt: new Date() } });
  });
  return result;
}

/** The settings from the moved variables, for a worker without BETTER_AUTH_SECRET. Values the page would refuse are left out. */
export function settingsFromEnvironment(env: Record<string, string | undefined> = process.env): { integrations: Integrations; refused: MovedVariable[] } {
  const values = movedVariables(env);
  const integrations: Integrations = {
    slack: { botToken: null, channelId: null },
    email: {
      provider: EMPTY.email.provider,
      fromAddress: "",
      fromName: "",
      smtp: { ...EMPTY.email.smtp, password: null },
      mailersendToken: null,
    },
    webhook: { url: null, secret: null },
  };
  const refused: MovedVariable[] = [];
  for (const name of MOVED_VARIABLES) {
    const raw = values[name];
    if (raw === undefined) continue;
    const value = rule(name).read(raw);
    if (value === undefined) refused.push(name);
    else rule(name).use(integrations, value);
  }
  return { integrations, refused };
}

/**
 * Logs what the import did and which moved variables are still set: one
 * warning, names only.
 */
export function logMovedVariables(result: ImportResult, env: Record<string, string | undefined> = process.env): void {
  if (result.copied.length > 0) logger.info({ variables: result.copied }, "settings copied from the environment to Admin › Integrations");
  if (result.refused.length > 0) {
    logger.warn({ variables: result.refused }, "values the Integrations page refuses were not copied: enter these settings under Admin › Integrations");
  }
  const leftovers = MOVED_VARIABLES.filter((name) => movedVariables(env)[name] !== undefined);
  if (leftovers.length === 0) return;
  if (result.waiting.length > 0) {
    logger.warn(
      { variables: leftovers },
      "these variables are still read because BETTER_AUTH_SECRET is missing (an older compose.yaml): take the compose.yaml of this release, then delete them from .env",
    );
  } else {
    logger.warn({ variables: leftovers }, "variables no longer read: Slack, email, and the webhook are set under Admin › Integrations. Delete them from .env");
  }
}
