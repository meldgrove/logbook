import { desc, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { auditActor, type SettingsActor } from "@/lib/audit/actor";
import { recordAudit } from "@/lib/audit";
import { movedVariables, parseNotificationModeConfig, parseSealingConfig, type MovedVariable } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import { workerHeartbeat } from "@/lib/db/schema";
import { errorMessage } from "@/lib/logger";
import { createTransports, emailReady, type Transports } from "@/lib/notifications/transports";
import { deriveSealingKey, seal, secretHint, type SealingKey } from "./crypto";
import {
  emailTestSchema,
  fieldErrorsOf,
  INPUT_SCHEMAS,
  type EmailView,
  type IntegrationFieldErrors,
  type IntegrationName,
  type IntegrationState,
  type IntegrationViews,
  type SlackView,
  type TestResult,
  type WebhookView,
} from "./schemas";
import {
  loadStored,
  openStored,
  SECRET_FIELDS,
  writeStored,
  type Sealed,
  type StoredEmail,
  type StoredIntegrations,
  type StoredSlack,
  type StoredWebhook,
  type Unreadable,
} from "./store";

/*
 * Admin › Integrations: Slack, email, and the webhook. The page's Server
 * Actions and `cli settings` call these functions, so both run the same
 * checks, seal secrets the same way, and write the same audit events. Only
 * the worker sends; it reads these settings while it runs (runtime.ts).
 */

/** The app refuses a body: the message, and a message per field. */
export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: IntegrationFieldErrors = {},
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export const CHECK_FIELDS = "Check the highlighted fields.";

/** What a setting is called in messages. */
export const INTEGRATION_LABELS: Record<IntegrationName, string> = { slack: "Slack", email: "email", webhook: "the webhook" };

/** Which setting each moved variable belonged to. */
export const MOVED_TO: Record<MovedVariable, IntegrationName> = {
  SLACK_BOT_TOKEN: "slack",
  SLACK_CHANNEL_ID: "slack",
  SMTP_URL: "email",
  MAILERSEND_API_TOKEN: "email",
  MAIL_FROM: "email",
  MAIL_FROM_NAME: "email",
  WEBHOOK_URL: "webhook",
  WEBHOOK_SECRET: "webhook",
};

const NO_KEY =
  "This process has no BETTER_AUTH_SECRET, so it cannot store or read secrets. Run it with the compose.yaml of this release, which passes BETTER_AUTH_SECRET to every service.";
const UNREADABLE = "The saved value cannot be read with the current BETTER_AUTH_SECRET: enter it again.";

let sealingKey: { secret: string; key: SealingKey } | undefined;

/** The key from this process's BETTER_AUTH_SECRET, or null without one. */
export function currentSealingKey(): SealingKey | null {
  const secret = parseSealingConfig().BETTER_AUTH_SECRET;
  if (!secret) return null;
  if (sealingKey?.secret !== secret) sealingKey = { secret, key: deriveSealingKey(secret) };
  return sealingKey.key;
}

/** What the worker reports about its environment (its heartbeat). */
export interface WorkerEnvironment {
  /** Moved variables still set for the worker. */
  movedVariables: MovedVariable[];
  /** The worker has no BETTER_AUTH_SECRET and sends with the moved variables. */
  settingsFromEnvironment: boolean;
}

/** The latest worker heartbeat's report, or nothing while no worker has reported. */
export async function workerEnvironment(db: Database): Promise<WorkerEnvironment> {
  const [row] = await db
    .select({ channels: workerHeartbeat.channels })
    .from(workerHeartbeat)
    .where(isNotNull(workerHeartbeat.beatAt))
    .orderBy(desc(workerHeartbeat.beatAt))
    .limit(1);
  return {
    movedVariables: (row?.channels?.movedVariables ?? []).filter((name): name is MovedVariable => name in MOVED_TO),
    settingsFromEnvironment: row?.channels?.settingsFromEnvironment === true,
  };
}

/** Where the views look: this process's key and environment, and the worker's report. */
export interface ViewContext {
  key: SealingKey | null;
  /** Moved variables set for this process or the worker, in a fixed order. */
  leftovers: MovedVariable[];
  settingsFromEnvironment: boolean;
}

export async function viewContext(db: Database, env: Record<string, string | undefined> = process.env): Promise<ViewContext> {
  const worker = await workerEnvironment(db);
  const seen = new Set<string>([...Object.keys(movedVariables(env)), ...worker.movedVariables]);
  return {
    key: currentSealingKey(),
    leftovers: (Object.keys(MOVED_TO) as MovedVariable[]).filter((name) => seen.has(name)),
    settingsFromEnvironment: worker.settingsFromEnvironment,
  };
}

const list = (names: string[]) => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The page's warnings for a setting: old variables still set, a worker without the key, secrets that cannot be read. */
function warningsFor(name: IntegrationName, context: ViewContext, unreadable: Unreadable[]): string[] {
  const warnings: string[] = [];
  const leftovers = context.leftovers.filter((variable) => MOVED_TO[variable] === name);
  const one = leftovers.length === 1;
  if (context.settingsFromEnvironment) {
    const reads = leftovers.length > 0 ? `still sends with ${list(leftovers)} from .env and ignores this page` : "ignores this page";
    warnings.push(
      `The worker has no BETTER_AUTH_SECRET (the compose.yaml of an earlier version), so it ${reads}. Give it the compose.yaml of this release (docs/deployment.md, "Moved from .env").`,
    );
  } else if (leftovers.length > 0) {
    warnings.push(
      `${list(leftovers)} ${one ? "is" : "are"} still set in the environment. Logbook no longer reads ${one ? "it" : "them"}: this page holds the setting. Delete ${one ? "it" : "them"} from .env.`,
    );
  }
  for (const field of unreadable) {
    if (field.split(".")[0] === name) warnings.push(`${SECRET_LABELS[field]}: ${UNREADABLE}`);
  }
  return warnings;
}

const SECRET_LABELS: Record<Unreadable, string> = {
  "slack.botToken": "The bot token",
  "email.smtp.password": "The SMTP password",
  "email.mailersend.token": "The MailerSend API token",
  "webhook.secret": "The signing secret",
};

const saved = (value: Sealed | null) => ({ saved: value !== null, hint: value?.hint ?? null });

function slackState(slack: StoredSlack, unreadable: Unreadable[]): IntegrationState {
  if (slack.botToken && !unreadable.includes(SECRET_FIELDS.slackBotToken)) return "set";
  return slack.botToken || slack.channelId ? "incomplete" : "not set";
}

function emailState(email: StoredEmail, unreadable: Unreadable[]): IntegrationState {
  if (email.provider === "none") return "not set";
  const has = (value: Sealed | null, field: Unreadable) => value !== null && !unreadable.includes(field);
  const ready = emailReady({
    provider: email.provider,
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    smtp: { ...email.smtp, password: has(email.smtp.password, SECRET_FIELDS.smtpPassword) ? "saved" : null },
    mailersendToken: has(email.mailersend.token, SECRET_FIELDS.mailerSendToken) ? "saved" : null,
  });
  return ready ? "set" : "incomplete";
}

function webhookState(webhook: StoredWebhook, unreadable: Unreadable[]): IntegrationState {
  if (!webhook.url) return "not set";
  return webhook.secret && !unreadable.includes(SECRET_FIELDS.webhookSecret) ? "set" : "incomplete";
}

/** What the page shows, and what `cli settings show` prints. */
export function viewsOf(stored: StoredIntegrations, context: ViewContext): IntegrationViews {
  // Without a key nothing can be opened, which says nothing about the values.
  const unreadable = context.key ? openStored(stored, context.key).unreadable : [];
  const { slack, email, webhook } = stored;
  const botToken = saved(slack.botToken);
  const password = saved(email.smtp.password);
  const token = saved(email.mailersend.token);
  const secret = saved(webhook.secret);
  const slackView: SlackView = {
    state: slackState(slack, unreadable),
    botTokenSaved: botToken.saved,
    botTokenHint: botToken.hint,
    channelId: slack.channelId,
    warnings: warningsFor("slack", context, unreadable),
  };
  const emailView: EmailView = {
    state: emailState(email, unreadable),
    provider: email.provider,
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    smtp: {
      host: email.smtp.host,
      port: email.smtp.port,
      security: email.smtp.security,
      username: email.smtp.username,
      passwordSaved: password.saved,
      passwordHint: password.hint,
    },
    mailersend: { tokenSaved: token.saved, tokenHint: token.hint },
    warnings: warningsFor("email", context, unreadable),
  };
  const webhookView: WebhookView = {
    state: webhookState(webhook, unreadable),
    url: webhook.url,
    secretSaved: secret.saved,
    secretHint: secret.hint,
    warnings: warningsFor("webhook", context, unreadable),
  };
  return { slack: slackView, email: emailView, webhook: webhookView };
}

export async function integrationViews(db: Database, context?: ViewContext): Promise<IntegrationViews> {
  const [{ stored }, resolved] = await Promise.all([loadStored(db), context ?? viewContext(db)]);
  return viewsOf(stored, resolved);
}

/**
 * A secret field after a save: undefined keeps the saved value, null removes
 * it, text is sealed. Sealing needs the key.
 */
function nextSecret(current: Sealed | null, input: string | null | undefined, field: Unreadable, key: SealingKey | null, path: string): Sealed | null {
  if (input === undefined) return current;
  if (input === null) return null;
  if (!key) throw new IntegrationError(NO_KEY, { [path]: "Not saved: this process cannot seal secrets." });
  return { sealed: seal(key, field, input), hint: secretHint(input) };
}

/** Whether a saved secret is usable for the checks: present, and readable when the key is at hand. */
function usable(value: Sealed | null, field: Unreadable, unreadable: Unreadable[]): boolean {
  return value !== null && !unreadable.includes(field);
}

function nextSlack(current: StoredSlack, body: unknown, key: SealingKey | null): StoredSlack {
  const input = INPUT_SCHEMAS.slack.parse(body);
  return {
    botToken: nextSecret(current.botToken, input.botToken, SECRET_FIELDS.slackBotToken, key, "botToken"),
    channelId: input.channelId,
  };
}

function nextEmail(current: StoredEmail, body: unknown, key: SealingKey | null): StoredEmail {
  const input = INPUT_SCHEMAS.email.parse(body);
  const next: StoredEmail = {
    provider: input.provider,
    fromAddress: input.fromAddress,
    fromName: input.fromName,
    smtp: {
      host: input.smtp.host,
      port: input.smtp.port,
      security: input.smtp.security,
      username: input.smtp.username,
      password: nextSecret(current.smtp.password, input.smtp.password, SECRET_FIELDS.smtpPassword, key, "smtp.password"),
    },
    mailersend: {
      token: nextSecret(current.mailersend.token, input.mailersend.token, SECRET_FIELDS.mailerSendToken, key, "mailersend.token"),
    },
  };
  const unreadable = key ? openStored({ ...emptyBut("email", next) }, key).unreadable : [];
  const errors: IntegrationFieldErrors = {};
  if (next.fromAddress && !z.email().safeParse(next.fromAddress).success) errors.fromAddress = "Enter an email address.";
  if (next.provider !== "none") {
    if (!next.fromAddress) errors.fromAddress = "Enter the sender address.";
    if (next.provider === "smtp") {
      const password = usable(next.smtp.password, SECRET_FIELDS.smtpPassword, unreadable);
      if (!next.smtp.host) errors["smtp.host"] = "Enter the mail server.";
      if (next.smtp.username && !password) {
        errors["smtp.password"] = next.smtp.password ? UNREADABLE : "Enter the password for this user name.";
      }
      if (!next.smtp.username && next.smtp.password) errors["smtp.username"] = "Enter the user name for this password.";
    } else if (!usable(next.mailersend.token, SECRET_FIELDS.mailerSendToken, unreadable)) {
      errors["mailersend.token"] = next.mailersend.token ? UNREADABLE : "Enter the API token.";
    }
  }
  if (Object.keys(errors).length > 0) throw new IntegrationError(CHECK_FIELDS, errors);
  return next;
}

function nextWebhook(current: StoredWebhook, body: unknown, key: SealingKey | null): StoredWebhook {
  const input = INPUT_SCHEMAS.webhook.parse(body);
  const next: StoredWebhook = {
    url: input.url,
    secret: nextSecret(current.secret, input.secret, SECRET_FIELDS.webhookSecret, key, "secret"),
  };
  const unreadable = key ? openStored(emptyBut("webhook", next), key).unreadable : [];
  if (next.url && !usable(next.secret, SECRET_FIELDS.webhookSecret, unreadable)) {
    throw new IntegrationError(CHECK_FIELDS, {
      secret: next.secret ? UNREADABLE : "Enter a signing secret of at least 16 characters.",
    });
  }
  return next;
}

function emptyBut<N extends IntegrationName>(name: N, value: StoredIntegrations[N]): StoredIntegrations {
  const stored: StoredIntegrations = {
    slack: { botToken: null, channelId: null },
    email: {
      provider: "none",
      fromAddress: "",
      fromName: "",
      smtp: { host: "", port: 587, security: "starttls", username: "", password: null },
      mailersend: { token: null },
    },
    webhook: { url: null, secret: null },
  };
  return { ...stored, [name]: value };
}

/** The fields of a setting that a save changed, by path; secrets by name only. */
export function changedFields(before: unknown, after: unknown, prefix = ""): string[] {
  if (before && after && typeof before === "object" && typeof after === "object" && !("sealed" in after) && !("sealed" in before)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      changedFields((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], `${prefix}${key}.`),
    );
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? [] : [prefix.slice(0, -1)];
}

const NEXT = { slack: nextSlack, email: nextEmail, webhook: nextWebhook } as const;

/**
 * Saves a setting from the page's body, with the page's checks, and records
 * an audit event (who, and which fields changed; never a value). Throws
 * IntegrationError when the app refuses the body.
 */
export async function saveIntegration(
  db: Database,
  name: IntegrationName,
  body: unknown,
  actor: SettingsActor,
  key: SealingKey | null = currentSealingKey(),
): Promise<{ message: string; view: IntegrationViews[IntegrationName] }> {
  const parsed = INPUT_SCHEMAS[name].safeParse(body);
  if (!parsed.success) throw new IntegrationError(CHECK_FIELDS, fieldErrorsOf(parsed.error));
  const { actorId, payload } = auditActor(actor);
  await db.transaction(async (tx) => {
    const { stored } = await loadStored(tx, { forUpdate: true });
    const before = stored[name];
    const next = (NEXT[name] as (current: typeof before, body: unknown, key: SealingKey | null) => typeof before)(before, body, key);
    await writeStored(tx, name, next, actorId);
    await recordAudit(tx, {
      actorId,
      action: `settings.${name}_changed`,
      payload: { ...payload, changed: changedFields(before, next) },
    });
  });
  const views = await integrationViews(db);
  return { message: `Saved ${INTEGRATION_LABELS[name]}.`, view: views[name] };
}

/** The settings as the worker would send with them now. */
async function transportsNow(db: Database, key: SealingKey | null) {
  const { stored } = await loadStored(db);
  const { integrations, unreadable } = openStored(stored, key);
  const mode = parseNotificationModeConfig().NOTIFICATION_TRANSPORT;
  // Links in test messages are not needed: the base URL can be missing here.
  const transports: Transports = createTransports({ mode, baseUrl: "", slack: integrations.slack, email: integrations.email });
  return { stored, integrations, unreadable, mode, transports };
}

const CONSOLE = "NOTIFICATION_TRANSPORT is console: Logbook only logs messages, so the test message went to the log.";

/**
 * The Slack test button: checks the saved token with Slack and, when a
 * channel is set, posts a test message there. Sends nothing else.
 */
export async function testSlack(db: Database, key: SealingKey | null = currentSealingKey()): Promise<TestResult> {
  const { stored, unreadable, mode, transports } = await transportsNow(db, key);
  if (!stored.slack.botToken) return { ok: false, message: "Save a bot token first." };
  if (unreadable.includes(SECRET_FIELDS.slackBotToken)) return { ok: false, message: key ? `The bot token: ${UNREADABLE}` : NO_KEY };
  const slack = transports.slack!;
  const channel = stored.slack.channelId;
  try {
    const { team, user } = await slack.testAuth();
    if (channel) await slack.postMessage(channel, "This is a test message from Logbook (Admin › Integrations). New entries are posted to this channel.");
    if (mode === "console") return { ok: true, message: CONSOLE };
    const who = `workspace ${team || "unknown"}, bot ${user || "unknown"}`;
    return {
      ok: true,
      message: channel
        ? `Slack accepted the token (${who}), and Logbook posted a test message to the channel.`
        : `Slack accepted the token (${who}). No channel is set, so nothing was posted.`,
    };
  } catch (error) {
    return { ok: false, message: `Slack refused: ${errorMessage(error)}` };
  }
}

/** The email test button: sends a test email to `to` with the saved settings. */
export async function testEmail(db: Database, input: unknown, key: SealingKey | null = currentSealingKey()): Promise<TestResult> {
  const parsed = emailTestSchema.safeParse(input);
  if (!parsed.success) throw new IntegrationError(CHECK_FIELDS, fieldErrorsOf(parsed.error));
  const { stored, unreadable, mode, transports } = await transportsNow(db, key);
  const secrets = unreadable.filter((field) => field.startsWith("email."));
  if (secrets.length > 0) return { ok: false, message: key ? `${SECRET_LABELS[secrets[0]!]}: ${UNREADABLE}` : NO_KEY };
  if (stored.email.provider === "none" || !transports.email) {
    return { ok: false, message: "Email is not set up: save a provider, its server or API token, and the sender first." };
  }
  try {
    await transports.email.send({
      to: parsed.data.to,
      toName: parsed.data.to,
      subject: "Test email from Logbook",
      text: "This is a test email from Logbook (Admin › Integrations). Reminders and notifications will arrive like this one.",
      html: "<p>This is a test email from Logbook (Admin › Integrations). Reminders and notifications will arrive like this one.</p>",
    });
    return { ok: true, message: mode === "console" ? CONSOLE : `Sent a test email to ${parsed.data.to}.` };
  } catch (error) {
    return { ok: false, message: `The test email could not be sent: ${errorMessage(error)}` };
  }
}
