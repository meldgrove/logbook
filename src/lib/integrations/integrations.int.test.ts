import { like } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { seedDirectory } from "../../../tests/integration/seed";
import { appSetting, auditEvent, workerHeartbeat } from "@/lib/db/schema";
import { deriveSealingKey } from "./crypto";
import { importMovedVariables } from "./moved-variables";
import { createIntegrationsRuntime } from "./runtime";
import { IntegrationError, integrationViews, saveIntegration, testEmail, testSlack, viewContext } from "./service";

const testDb = connectTestDatabase();
const { db } = testDb;
let amy: { personId: string };

const KEY = deriveSealingKey("k".repeat(32));
const OTHER_KEY = deriveSealingKey("o".repeat(32));
const TOKEN = "xoxb-integration-secret-7f3a";
const PASSWORD = "smtp-secret-password-9c1d";
const SIGNING = "webhook-signing-secret-2b8e";

beforeEach(async () => {
  await testDb.reset();
  const seed = await seedDirectory(db);
  amy = { personId: seed.people.amy.id };
  vi.stubEnv("BETTER_AUTH_SECRET", "k".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => testDb.close());

const rows = async () => Object.fromEntries((await db.select().from(appSetting)).map((row) => [row.key, row.value]));
const audits = async () => db.select().from(auditEvent).where(like(auditEvent.action, "settings.%")).orderBy(auditEvent.id);

/** A stand-in for Slack's Web API and MailerSend, as the transport tests use. */
function fakeFetch(answers: Record<string, unknown>) {
  const calls: { url: string; body: unknown; authorization: string | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      calls.push({
        url: target,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      const answer = Object.entries(answers).find(([prefix]) => target.startsWith(prefix))?.[1] ?? { ok: true };
      return new Response(typeof answer === "number" ? "" : JSON.stringify(answer), { status: typeof answer === "number" ? answer : 200 });
    }),
  );
  return calls;
}

describe("saving on the page and with the command", () => {
  it("seals the secret, shows only its hint, and records who changed which fields", async () => {
    const { message, view } = await saveIntegration(db, "slack", { botToken: TOKEN, channelId: "C0123456789" }, amy, KEY);
    expect(message).toBe("Saved Slack.");
    expect(view).toEqual({ state: "set", botTokenSaved: true, botTokenHint: "…7f3a", channelId: "C0123456789", warnings: [] });
    expect(JSON.stringify(await rows())).not.toContain(TOKEN);
    const [event] = await audits();
    expect(event).toMatchObject({ actorId: amy.personId, action: "settings.slack_changed", payload: { changed: ["botToken", "channelId"] } });
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it("keeps a secret the body leaves out, removes it with null, and replaces every other field", async () => {
    await saveIntegration(db, "slack", { botToken: TOKEN, channelId: "C0123456789" }, amy, KEY);
    const kept = await saveIntegration(db, "slack", { botToken: "", channelId: null }, amy, KEY);
    expect(kept.view).toMatchObject({ botTokenSaved: true, botTokenHint: "…7f3a", channelId: null });
    const removed = await saveIntegration(db, "slack", { botToken: null }, amy, KEY);
    expect(removed.view).toMatchObject({ state: "not set", botTokenSaved: false });
    // The row stays: an old variable is not copied over a setting an admin turned off.
    expect(await rows()).toHaveProperty("slack");
  });

  it("refuses a body as the page does, and saves nothing", async () => {
    const refused = await saveIntegration(db, "email", { provider: "smtp", fromAddress: "nope", smtp: { username: "u" } }, amy, KEY).catch((e) => e);
    expect(refused).toBeInstanceOf(IntegrationError);
    expect(refused.message).toBe("Check the highlighted fields.");
    expect(refused.fieldErrors).toEqual({
      fromAddress: "Enter an email address.",
      "smtp.host": "Enter the mail server.",
      "smtp.password": "Enter the password for this user name.",
    });
    await expect(saveIntegration(db, "email", { provider: "mailersend", fromAddress: "logbook@example.org" }, amy, KEY)).rejects.toMatchObject({
      fieldErrors: { "mailersend.token": "Enter the API token." },
    });
    await expect(saveIntegration(db, "webhook", { url: "https://hooks.example.org/logbook" }, amy, KEY)).rejects.toMatchObject({
      fieldErrors: { secret: "Enter a signing secret of at least 16 characters." },
    });
    expect(await rows()).toEqual({});
    expect(await audits()).toEqual([]);
  });

  it("saves SMTP with its password, and switching the provider keeps the other's fields", async () => {
    const body = {
      provider: "smtp",
      fromAddress: "logbook@example.org",
      fromName: "",
      smtp: { host: "mail.example.org", port: 465, security: "tls", username: "logbook", password: PASSWORD },
    };
    const saved = await saveIntegration(db, "email", body, amy, KEY);
    expect(saved.view).toMatchObject({ state: "set", smtp: { host: "mail.example.org", port: 465, passwordSaved: true, passwordHint: "…9c1d" } });
    const off = await saveIntegration(db, "email", { ...body, provider: "none", smtp: { ...body.smtp, password: undefined } }, amy, KEY);
    expect(off.view).toMatchObject({ state: "not set", smtp: { host: "mail.example.org", passwordSaved: true } });
    expect(JSON.stringify(await rows())).not.toContain(PASSWORD);
  });

  it("asks for the SMTP password again before it would go to another server or travel less protected", async () => {
    const body = {
      provider: "smtp",
      fromAddress: "logbook@example.org",
      smtp: { host: "mail.example.org", port: 587, security: "starttls", username: "logbook", password: PASSWORD },
    };
    await saveIntegration(db, "email", body, amy, KEY);
    const kept = { ...body, smtp: { ...body.smtp, password: undefined } };
    const elsewhere = { ...kept, smtp: { ...kept.smtp, host: "mail.attacker.example" } };
    await expect(saveIntegration(db, "email", elsewhere, amy, KEY)).rejects.toMatchObject({
      fieldErrors: { "smtp.password": "Enter the password again: the mail server changed." },
    });
    // Also while another provider is chosen, which would carry the new server over unchecked.
    await expect(saveIntegration(db, "email", { ...elsewhere, provider: "none" }, amy, KEY)).rejects.toMatchObject({
      fieldErrors: { "smtp.password": "Enter the password again: the mail server changed." },
    });
    await expect(saveIntegration(db, "email", { ...kept, smtp: { ...kept.smtp, security: "auto" } }, amy, KEY)).rejects.toMatchObject({
      fieldErrors: { "smtp.password": "Enter the password again: the encryption is weaker now." },
    });
    // A body without `smtp` keeps the saved SMTP settings, as the documented {"provider": "none"} does.
    expect((await saveIntegration(db, "email", { provider: "none" }, amy, KEY)).view).toMatchObject({
      state: "not set",
      smtp: { host: "mail.example.org", passwordSaved: true },
    });
    expect(
      (await saveIntegration(db, "email", { provider: "mailersend", fromAddress: "logbook@example.org", mailersend: { token: "mlsn.token-1234" } }, amy, KEY)).view,
    ).toMatchObject({ state: "set", smtp: { host: "mail.example.org", passwordSaved: true } });
    // The same server and protection keep it; a new password or none at all may go anywhere.
    expect((await saveIntegration(db, "email", { ...kept, smtp: { ...kept.smtp, port: 465, security: "tls" } }, amy, KEY)).view.state).toBe("set");
    expect((await saveIntegration(db, "email", { ...elsewhere, smtp: { ...elsewhere.smtp, password: "a-new-password-0000" } }, amy, KEY)).view).toMatchObject({
      smtp: { host: "mail.attacker.example", passwordHint: "…0000" },
    });
  });

  it("waits for an import that runs at the same time, also before the setting has a row", async () => {
    const client = await testDb.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('logbook.integrations'))");
      const save = saveIntegration(db, "slack", { channelId: "C0123456789" }, amy, KEY);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // What a concurrent import writes while it holds the lock.
      await client.query("insert into app_setting (key, value) values ('slack', $1)", [
        JSON.stringify({ botToken: { sealed: "v1.imported.value", hint: "…7f3a" }, channelId: null }),
      ]);
      await client.query("commit");
      expect((await save).view).toMatchObject({ botTokenSaved: true, botTokenHint: "…7f3a", channelId: "C0123456789" });
    } finally {
      client.release();
    }
  });

  it("cannot store a new secret without BETTER_AUTH_SECRET, but changes other fields", async () => {
    await saveIntegration(db, "slack", { botToken: TOKEN }, amy, KEY);
    await expect(saveIntegration(db, "slack", { botToken: "xoxb-other-token-1234" }, amy, null)).rejects.toMatchObject({
      message: expect.stringContaining("no BETTER_AUTH_SECRET"),
      fieldErrors: { botToken: "Not saved: this process cannot seal secrets." },
    });
    const { view } = await saveIntegration(db, "slack", { channelId: "C0123456789" }, amy, null);
    expect(view).toMatchObject({ botTokenHint: "…7f3a", channelId: "C0123456789" });
  });

  it("says when a saved secret cannot be read with the current BETTER_AUTH_SECRET", async () => {
    await saveIntegration(db, "webhook", { url: "https://hooks.example.org/logbook", secret: SIGNING }, amy, OTHER_KEY);
    const views = await integrationViews(db);
    expect(views.webhook.state).toBe("incomplete");
    expect(views.webhook.warnings).toEqual([
      "The signing secret: The saved value cannot be read with the current BETTER_AUTH_SECRET: enter it again.",
    ]);
    await expect(saveIntegration(db, "webhook", { url: "https://hooks.example.org/other" }, amy, KEY)).rejects.toMatchObject({
      fieldErrors: { secret: "The saved value cannot be read with the current BETTER_AUTH_SECRET: enter it again." },
    });
    expect((await saveIntegration(db, "webhook", { url: "https://hooks.example.org/other", secret: SIGNING }, amy, KEY)).view.state).toBe("set");
  });
});

describe("the test buttons", () => {
  it("check the Slack token and post to the channel, with the saved token", async () => {
    vi.stubEnv("NOTIFICATION_TRANSPORT", "live");
    await saveIntegration(db, "slack", { botToken: TOKEN, channelId: "C0123456789" }, amy, KEY);
    const calls = fakeFetch({ "https://slack.com/api/auth.test": { ok: true, team: "Acme", user: "logbook" } });
    expect(await testSlack(db, KEY)).toEqual({
      ok: true,
      message: "Slack accepted the token (workspace Acme, bot logbook), and Logbook posted a test message to the channel.",
    });
    expect(calls.map((call) => [call.url, call.authorization])).toEqual([
      ["https://slack.com/api/auth.test", `Bearer ${TOKEN}`],
      ["https://slack.com/api/chat.postMessage", `Bearer ${TOKEN}`],
    ]);
    expect(calls[1]!.body).toMatchObject({ channel: "C0123456789" });

    fakeFetch({ "https://slack.com/api/auth.test": { ok: false, error: "invalid_auth" } });
    expect(await testSlack(db, KEY)).toEqual({ ok: false, message: "Slack refused: Slack auth.test: invalid_auth" });
  });

  it("send a test email through the saved provider, and refuse a bad address", async () => {
    vi.stubEnv("NOTIFICATION_TRANSPORT", "live");
    await saveIntegration(db, "email", { provider: "mailersend", fromAddress: "logbook@example.org", mailersend: { token: "mlsn.test-token-5e6f" } }, amy, KEY);
    const calls = fakeFetch({ "https://api.mailersend.com": 202 });
    expect(await testEmail(db, { to: "amy@example.org" }, KEY)).toEqual({ ok: true, message: "Sent a test email to amy@example.org." });
    expect(calls[0]).toMatchObject({ authorization: "Bearer mlsn.test-token-5e6f", body: { to: [{ email: "amy@example.org" }], from: { name: "Logbook" } } });
    await expect(testEmail(db, { to: "nope" }, KEY)).rejects.toMatchObject({ fieldErrors: { to: "Enter an email address." } });
    fakeFetch({ "https://api.mailersend.com": 401 });
    expect(await testEmail(db, { to: "amy@example.org" }, KEY)).toEqual({ ok: false, message: "The test email could not be sent: MailerSend: HTTP 401" });
  });

  it("only log in development, and say what is missing", async () => {
    expect(await testSlack(db, KEY)).toEqual({ ok: false, message: "Save a bot token first." });
    expect(await testEmail(db, { to: "amy@example.org" }, KEY)).toMatchObject({ ok: false, message: expect.stringContaining("Email is not set up") });
    await saveIntegration(db, "slack", { botToken: TOKEN }, amy, KEY);
    expect(await testSlack(db, KEY)).toEqual({ ok: true, message: expect.stringContaining("NOTIFICATION_TRANSPORT is console") });
  });
});

describe("variables that moved out of .env", () => {
  const OLD = {
    SLACK_BOT_TOKEN: TOKEN,
    SLACK_CHANNEL_ID: "C0123456789",
    SMTP_URL: `smtps://logbook:${PASSWORD}@mail.example.org`,
    MAIL_FROM: "logbook@example.org",
    MAIL_FROM_NAME: "Logbook (Acme)",
    WEBHOOK_URL: "https://hooks.example.org/logbook",
    WEBHOOK_SECRET: SIGNING,
  };

  it("are copied once, sealed, with an audit event per setting by the environment", async () => {
    const result = await importMovedVariables(db, { env: OLD, key: KEY });
    expect(result).toEqual({ copied: Object.keys(OLD), kept: [], refused: [], waiting: [] });
    const views = await integrationViews(db, { key: KEY, leftovers: [], settingsFromEnvironment: false, workerWithoutKey: false });
    expect(views.slack).toMatchObject({ state: "set", botTokenHint: "…7f3a", channelId: "C0123456789" });
    expect(views.email).toMatchObject({
      state: "set",
      provider: "smtp",
      fromName: "Logbook (Acme)",
      smtp: { host: "mail.example.org", port: 465, security: "tls", username: "logbook", passwordHint: "…9c1d" },
    });
    expect(views.webhook).toMatchObject({ state: "set", url: "https://hooks.example.org/logbook", secretHint: "…2b8e" });
    const stored = JSON.stringify(await rows());
    for (const secret of [TOKEN, PASSWORD, SIGNING]) expect(stored).not.toContain(secret);
    const events = await audits();
    expect(events.map((event) => [event.action, event.actorId, event.payload.actor, event.payload.variables])).toEqual([
      ["settings.slack_changed", null, "environment", ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"]],
      ["settings.email_changed", null, "environment", ["SMTP_URL", "MAIL_FROM", "MAIL_FROM_NAME"]],
      ["settings.webhook_changed", null, "environment", ["WEBHOOK_URL", "WEBHOOK_SECRET"]],
    ]);
    expect(JSON.stringify(events)).not.toMatch(new RegExp(`${TOKEN}|${PASSWORD}|${SIGNING}`));
  });

  it("are never copied again, also after an admin cleared the field", async () => {
    await importMovedVariables(db, { env: OLD, key: KEY });
    await saveIntegration(db, "slack", { botToken: null }, amy, KEY);
    expect(await importMovedVariables(db, { env: OLD, key: KEY })).toEqual({ copied: [], kept: [], refused: [], waiting: [] });
    expect((await integrationViews(db)).slack.botTokenSaved).toBe(false);
  });

  it("do not overwrite what the database has, and a value the page refuses is left out", async () => {
    await saveIntegration(db, "webhook", { url: "https://hooks.example.org/saved", secret: "a-saved-secret-0000" }, amy, KEY);
    const result = await importMovedVariables(db, { env: { ...OLD, SLACK_CHANNEL_ID: "#logbook" }, key: KEY });
    expect(result.kept).toEqual(["WEBHOOK_URL", "WEBHOOK_SECRET"]);
    expect(result.refused).toEqual(["SLACK_CHANNEL_ID"]);
    const views = await integrationViews(db);
    expect(views.webhook).toMatchObject({ url: "https://hooks.example.org/saved", secretHint: "…0000" });
    expect(views.slack).toMatchObject({ botTokenSaved: true, channelId: null });
  });

  it("are copied by one process when several start together, also when each sees only some", async () => {
    const results = await Promise.all([
      importMovedVariables(db, { env: OLD, key: KEY }),
      importMovedVariables(db, { env: OLD, key: KEY }),
      // An old Compose file may pass a variable to one service only.
      importMovedVariables(db, { env: { MAIL_FROM: OLD.MAIL_FROM }, key: KEY }),
    ]);
    expect(results.flatMap((result) => result.copied).sort()).toEqual(Object.keys(OLD).sort());
    expect((await audits()).length).toBeLessThanOrEqual(4);
    expect((await audits()).filter((event) => event.action === "settings.slack_changed")).toHaveLength(1);
  });

  it("wait while the process has no BETTER_AUTH_SECRET", async () => {
    expect(await importMovedVariables(db, { env: OLD, key: null })).toMatchObject({ copied: [], waiting: Object.keys(OLD) });
    expect(await rows()).toEqual({});
  });

  it("are named also when the worker has no BETTER_AUTH_SECRET and no old variables", async () => {
    await db.insert(workerHeartbeat).values({
      workerId: "w1",
      startedAt: new Date(),
      beatAt: new Date(),
      channels: { slack: "off", email: "off", movedVariables: [], settingsFromEnvironment: false, withoutKey: true },
    });
    const views = await integrationViews(db, await viewContext(db, { SLACK_BOT_TOKEN: TOKEN }));
    expect(views.slack.warnings).toEqual([
      expect.stringMatching(/so it cannot read the secrets saved here/),
      "SLACK_BOT_TOKEN is still set in the environment. Logbook no longer reads it: this page holds the setting. Delete it from .env.",
    ]);
  });

  it("are named on the page while they are still set, for this process or the worker", async () => {
    await db.insert(workerHeartbeat).values({
      workerId: "w1",
      startedAt: new Date(),
      beatAt: new Date(),
      channels: { slack: "off", email: "off", movedVariables: ["WEBHOOK_SECRET", "MAIL_FROM"] },
    });
    const views = await integrationViews(db, await viewContext(db, { SLACK_BOT_TOKEN: TOKEN }));
    expect(views.slack.warnings).toEqual([
      "SLACK_BOT_TOKEN is still set in the environment. Logbook no longer reads it: this page holds the setting. Delete it from .env.",
    ]);
    expect(views.email.warnings).toEqual([expect.stringMatching(/^MAIL_FROM is still set/)]);
    expect(views.webhook.warnings).toEqual([expect.stringMatching(/^WEBHOOK_SECRET is still set/)]);
    expect(JSON.stringify(views)).not.toContain(TOKEN);
  });
});

describe("the worker", () => {
  it("picks up a change without a restart", async () => {
    vi.stubEnv("NOTIFICATION_TRANSPORT", "live");
    const runtime = createIntegrationsRuntime({ db: () => db, key: KEY, mode: "live", baseUrl: "https://logbook.example", env: {} });
    expect((await runtime.transports()).slack).toBeUndefined();
    expect(await runtime.webhook()).toBeNull();
    await saveIntegration(db, "slack", { botToken: TOKEN, channelId: "C0123456789" }, amy, KEY);
    await saveIntegration(db, "webhook", { url: "https://hooks.example.org/logbook", secret: SIGNING }, amy, KEY);
    expect((await runtime.transports()).slack?.mode).toBe("live");
    expect(await runtime.webhook()).toEqual({ url: "https://hooks.example.org/logbook", secret: SIGNING });
    expect(runtime.channels()).toEqual({
      slack: "live",
      slackChannel: "live",
      email: "off",
      webhook: "live",
      movedVariables: [],
      settingsFromEnvironment: false,
      withoutKey: false,
    });
  });

  it("says when it has no BETTER_AUTH_SECRET, also without old variables to fall back on", async () => {
    const runtime = createIntegrationsRuntime({ db: () => db, key: null, mode: "live", baseUrl: "https://logbook.example", env: {} });
    await saveIntegration(db, "slack", { botToken: TOKEN }, amy, KEY);
    expect((await runtime.transports()).slack).toBeUndefined();
    expect(runtime.channels()).toMatchObject({ settingsFromEnvironment: false, withoutKey: true });
    await db.insert(workerHeartbeat).values({ workerId: "w1", startedAt: new Date(), beatAt: new Date(), channels: runtime.channels() });
    expect((await integrationViews(db)).slack.warnings).toEqual([
      'The worker has no BETTER_AUTH_SECRET (the compose.yaml of an earlier version), so it cannot read the secrets saved here. Give it the compose.yaml of this release (docs/deployment.md, "Moved from .env").',
    ]);
  });

  it("sends with the old variables while it has no BETTER_AUTH_SECRET (an older compose.yaml), and says so", async () => {
    await saveIntegration(db, "slack", { botToken: "xoxb-saved-on-the-page-1" }, amy, KEY);
    const env = { SLACK_BOT_TOKEN: TOKEN, WEBHOOK_URL: "https://hooks.example.org/logbook", WEBHOOK_SECRET: SIGNING };
    const runtime = createIntegrationsRuntime({ db: () => db, key: null, mode: "live", baseUrl: "https://logbook.example", env });
    const calls = fakeFetch({});
    await (await runtime.transports()).slack!.postMessage("U1", "x");
    expect(calls[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(await runtime.webhook()).toEqual({ url: "https://hooks.example.org/logbook", secret: SIGNING });
    expect(runtime.channels()).toMatchObject({ movedVariables: ["SLACK_BOT_TOKEN", "WEBHOOK_URL", "WEBHOOK_SECRET"], settingsFromEnvironment: true });

    await db.insert(workerHeartbeat).values({ workerId: "w1", startedAt: new Date(), beatAt: new Date(), channels: runtime.channels() });
    expect((await integrationViews(db)).slack.warnings[0]).toBe('The worker has no BETTER_AUTH_SECRET (the compose.yaml of an earlier version), so it still sends with SLACK_BOT_TOKEN from .env and ignores this page. Give it the compose.yaml of this release (docs/deployment.md, "Moved from .env").');
  });

  it("with the key, copies the old variables and then reads only the database", async () => {
    const env = { SLACK_BOT_TOKEN: TOKEN };
    await importMovedVariables(db, { env, key: KEY });
    const runtime = createIntegrationsRuntime({ db: () => db, key: KEY, mode: "live", baseUrl: "https://logbook.example", env });
    await saveIntegration(db, "slack", { botToken: "xoxb-changed-on-the-page-1" }, amy, KEY);
    const calls = fakeFetch({});
    await (await runtime.transports()).slack!.postMessage("U1", "x");
    expect(calls[0]!.authorization).toBe("Bearer xoxb-changed-on-the-page-1");
    expect(runtime.channels()).toMatchObject({ movedVariables: ["SLACK_BOT_TOKEN"], settingsFromEnvironment: false });
  });
});
