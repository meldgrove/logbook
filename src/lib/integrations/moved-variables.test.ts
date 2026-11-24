import { describe, expect, it } from "vitest";
import { settingsFromEnvironment, smtpFromUrl } from "./moved-variables";

describe("smtpFromUrl", () => {
  it("reads an old SMTP_URL into the page's fields", () => {
    expect(smtpFromUrl("smtps://user%40example.org:p%40ss@mail.example.org")).toEqual({
      host: "mail.example.org",
      port: 465,
      security: "tls",
      username: "user@example.org",
      password: "p@ss",
    });
    // smtp:// upgraded to TLS only when the server offered it: a relay without STARTTLS keeps working.
    expect(smtpFromUrl("smtp://mail.example.org:2525")).toEqual({
      host: "mail.example.org",
      port: 2525,
      security: "auto",
      username: "",
      password: null,
    });
    expect(smtpFromUrl("smtp://relay.internal:25?ignoreTLS=true")?.security).toBe("none");
    expect(smtpFromUrl("smtp://mail.example.org?requireTLS=true")?.security).toBe("starttls");
    // As nodemailer reads the options: requireTLS wins over ignoreTLS, 1 counts as true, the scheme decides TLS.
    expect(smtpFromUrl("smtp://mail.example.org?requireTLS=true&ignoreTLS=true")?.security).toBe("starttls");
    expect(smtpFromUrl("smtp://mail.example.org?requireTLS=1")?.security).toBe("starttls");
    expect(smtpFromUrl("smtp://mail.example.org?ignoreTLS=false")?.security).toBe("auto");
    expect(smtpFromUrl("smtp://mail.example.org?secure=true")).toMatchObject({ port: 587, security: "auto" });
    expect(smtpFromUrl("smtps://mail.example.org?secure=false")).toMatchObject({ port: 465, security: "tls" });
  });

  it("refuses what is no SMTP URL", () => {
    expect(smtpFromUrl("https://mail.example.org")).toBeUndefined();
    expect(smtpFromUrl("not a url")).toBeUndefined();
  });
});

describe("settingsFromEnvironment", () => {
  it("gives a worker without BETTER_AUTH_SECRET the settings the old variables made", () => {
    const { integrations, refused } = settingsFromEnvironment({
      SLACK_BOT_TOKEN: "xoxb-1",
      SLACK_CHANNEL_ID: "C0123456",
      MAILERSEND_API_TOKEN: "mlsn.token",
      MAIL_FROM: "logbook@example.org",
      WEBHOOK_URL: "https://hooks.example.org/logbook",
      WEBHOOK_SECRET: "short",
    });
    expect(integrations.slack).toEqual({ botToken: "xoxb-1", channelId: "C0123456" });
    expect(integrations.email).toMatchObject({ provider: "mailersend", mailersendToken: "mlsn.token", fromAddress: "logbook@example.org", fromName: "" });
    // A value the page refuses is left out, so the webhook stays off.
    expect(integrations.webhook).toEqual({ url: "https://hooks.example.org/logbook", secret: null });
    expect(refused).toEqual(["WEBHOOK_SECRET"]);
  });
});
