import { describe, expect, it } from "vitest";
import {
  adoptInstall,
  afterInstallRequest,
  automaticText,
  buttonLabel,
  buttonState,
  durationText,
  failure,
  followInstall,
  hasPopover,
  installAction,
  installKey,
  installOutcome,
  installsAtText,
  moreChanges,
  stableHelp,
  stageLabel,
  timeAgo,
  type PendingInstall,
} from "./state";
import type { Update, UpdaterStatus, UpdatesResponse } from "./types";

const update: Update = {
  version: "0.2.1",
  preview: false,
  publishedAt: "2026-11-17T10:00:00Z",
  url: "https://github.com/meldgrove/logbook/releases/tag/v0.2.1",
  notes: ["One", "Two"],
  changes: 2,
  installsAt: "2026-11-20T02:00:00Z",
  failed: null,
};

const status: UpdaterStatus = {
  updater: "0.2.0",
  mode: "host",
  channel: "stable",
  channelLocked: null,
  installed: "0.2.0",
  available: null,
  attention: null,
  installing: null,
  last: null,
  checking: false,
  checkedAt: "2026-11-19T08:00:00Z",
  error: null,
  automatic: true,
  cooldown: "3d",
  window: "02:00-05:00",
  timezone: "UTC",
};

function answer(change: Partial<UpdaterStatus> = {}, app: string | null = "0.2.0"): UpdatesResponse {
  return { app: { version: app }, reachable: true, updater: { ...status, ...change }, error: null };
}

const idle = { checking: false, pending: null };
const pending: PendingInstall = {
  version: "0.2.1",
  startedAt: Date.parse("2026-11-19T09:00:00Z"),
  confirmed: true,
  sawOutage: false,
  reason: null,
};
const rolledBack = {
  version: "0.2.1",
  result: "rolled-back" as const,
  message: "container web is unhealthy. 0.2.0 runs again.",
  finishedAt: "2026-11-19T09:01:00Z",
};

describe("buttonState", () => {
  it.each([
    ["loading", null, idle],
    ["checking", null, { checking: true, pending: null }],
    ["unreachable", { app: { version: null }, reachable: false, updater: null, error: "ENOTFOUND" }, idle],
    ["up-to-date", answer(), idle],
    ["checking", answer({ checking: true }), idle],
    ["checking", answer({ available: update }), { checking: true, pending: null }],
    ["available", answer({ available: update }), idle],
    ["attention", answer({ attention: { ...update, version: "0.3.0" } }), idle],
    ["available", answer({ available: update, attention: { ...update, version: "0.3.0" } }), idle],
    ["installing", answer({ installing: { version: "0.2.1", startedAt: "2026-11-19T09:00:00Z", manual: true, stage: "pulling" } }), idle],
    ["installing", answer({ available: update }), { checking: false, pending }],
    ["installing", null, { checking: false, pending }],
    ["off", answer({ mode: "off", automatic: false }), idle],
    // Off installs nothing, but still offers new versions.
    ["available", answer({ mode: "off", automatic: false, available: update }), idle],
    ["attention", answer({ mode: "off", automatic: false, attention: { ...update, version: "0.3.0" } }), idle],
    ["failed", answer({ available: { ...update, failed: "unhealthy" }, last: rolledBack }), idle],
    ["failed", answer({ attention: { ...update, failed: "unhealthy" }, last: { ...rolledBack, result: "failed" } }), idle],
    // An earlier failure of a version that is no longer offered, or a failure the updater does not attach to an update.
    ["up-to-date", answer({ last: rolledBack }), idle],
    ["available", answer({ available: update, last: rolledBack }), idle],
    ["available", answer({ available: { ...update, failed: "unhealthy" }, last: { ...rolledBack, result: "installed" } }), idle],
  ] as const)("is %s", (expected, response, local) => {
    expect(buttonState(response, local)).toBe(expected);
  });

  it("opens a popover only when there is something to show", () => {
    expect(["available", "attention", "installing", "failed"].every((s) => hasPopover(s as never))).toBe(true);
    expect(["loading", "checking", "up-to-date", "off", "unreachable"].some((s) => hasPopover(s as never))).toBe(false);
  });
});

describe("buttonLabel", () => {
  it.each([
    ["loading", null, "Check for updates"],
    ["checking", answer(), "Checking for updates…"],
    ["up-to-date", answer(), "Up to date · 0.2.0"],
    ["up-to-date", answer({ installed: null }, null), "Up to date"],
    ["available", answer({ available: update }), "Update available · 0.2.1"],
    ["attention", answer({ attention: { ...update, version: "0.3.0" } }), "0.3.0 needs upgrade steps"],
    ["failed", answer({ available: { ...update, failed: "x" }, last: rolledBack }), "Update to 0.2.1 failed"],
    ["off", answer({ mode: "off" }), "Automatic updates are off on this server"],
    ["unreachable", null, "No update service. See the deployment guide."],
  ] as const)("%s: %s", (state, response, label) => {
    expect(buttonLabel(state, response, null)).toBe(label);
  });

  it("names the version being installed", () => {
    expect(buttonLabel("installing", answer(), pending)).toBe("Installing 0.2.1…");
    const installing = { version: "0.2.2", startedAt: "2026-11-19T09:00:00Z", manual: false, stage: "starting" };
    expect(buttonLabel("installing", answer({ installing }), null)).toBe("Installing 0.2.2…");
  });
});

describe("installOutcome", () => {
  const installing = { version: "0.2.1", startedAt: "2026-11-19T09:00:01Z", manual: true, stage: "starting" };
  const installed = { version: "0.2.1", result: "installed" as const, message: null, finishedAt: "2026-11-19T09:02:00Z" };

  it("is done when Logbook runs the version and nothing reports the installation any more", () => {
    expect(installOutcome(pending, answer({}, "0.2.1"))).toBe("done");
  });

  it("keeps waiting while the updater installs, even when Logbook already answers with the version", () => {
    // On a server, the new web container answers before the worker is healthy, and the installation may still go back.
    expect(installOutcome(pending, answer({ installing }, "0.2.1"))).toBe("waiting");
    expect(installOutcome(pending, answer({ installing: { ...installing, stage: "rolling-back" } }, "0.2.1"))).toBe("waiting");
  });

  it("is done when the server installed it, even without a version of its own (development)", () => {
    expect(installOutcome(pending, answer({ last: installed }, null))).toBe("done");
    expect(installOutcome(pending, answer({ last: installed }))).toBe("done");
  });

  it("waits for a platform's deployment until Logbook runs the version, or without a version, answered after an outage", () => {
    const accepted = { version: "0.2.1", result: "accepted" as const, message: null, finishedAt: "2026-11-19T09:00:01Z" };
    expect(installOutcome(pending, answer({ last: accepted }))).toBe("waiting");
    expect(installOutcome({ ...pending, sawOutage: true }, answer({ last: accepted }))).toBe("waiting");
    expect(installOutcome(pending, answer({ last: accepted }, "0.2.1"))).toBe("done");
    expect(installOutcome(pending, answer({ last: accepted }, null))).toBe("waiting");
    expect(installOutcome({ ...pending, sawOutage: true }, answer({ last: accepted }, null))).toBe("done");
  });

  it("fails when the server failed or went back, before anything else counts", () => {
    expect(installOutcome(pending, answer({ last: rolledBack }))).toBe("failed");
    expect(installOutcome(pending, answer({ last: { ...rolledBack, result: "failed" } }))).toBe("failed");
    expect(installOutcome(pending, answer({ last: rolledBack }, "0.2.1"))).toBe("failed");
  });

  it("ignores results of other versions and results from before the installation started", () => {
    expect(installOutcome(pending, answer({ last: { ...rolledBack, version: "0.2.2" } }))).toBe("waiting");
    const stale = { ...rolledBack, finishedAt: "2026-11-19T08:59:59Z" };
    expect(installOutcome(pending, answer({ last: stale }))).toBe("waiting");
    expect(installOutcome(pending, answer({ last: { ...stale, result: "installed" } }))).toBe("waiting");
    expect(installOutcome(pending, answer({ last: { ...rolledBack, finishedAt: "2026-11-19T09:00:00Z" } }))).toBe("failed");
    expect(installOutcome(pending, answer({ installing }))).toBe("waiting");
  });
});

describe("failure", () => {
  const failedResponse = answer({ available: update, last: { ...rolledBack, message: "container web is unhealthy." } });

  it("shows the failure of a followed installation from its result, also when the offer has no failure", () => {
    const shown = failure(failedResponse.updater!, pending);
    expect(shown).toEqual({ version: "0.2.1", message: "container web is unhealthy.", update });
    expect(buttonState(failedResponse, { checking: false, pending: null, followed: pending })).toBe("failed");
    expect(buttonLabel("failed", failedResponse, null, pending)).toBe("Update to 0.2.1 failed");
    // Without the followed installation, the updater's offer decides.
    expect(buttonState(failedResponse, idle)).toBe("available");
  });

  it("offers to try again only while the version is still offered", () => {
    expect(failure(answer({ last: rolledBack }).updater!, pending)).toEqual({ version: "0.2.1", message: rolledBack.message, update: null });
    const other = answer({ available: { ...update, version: "0.2.2" }, last: rolledBack }).updater!;
    expect(failure(other, pending)?.update).toBeNull();
    const attention = { ...update, version: "0.2.1", failed: null };
    expect(failure(answer({ attention, last: rolledBack }).updater!, pending)?.update).toBe(attention);
  });

  it("ignores a result from before the followed installation started", () => {
    const stale = answer({ available: update, last: { ...rolledBack, finishedAt: "2026-11-19T08:59:00Z" } });
    expect(failure(stale.updater!, pending)).toBeNull();
    expect(buttonState(stale, { checking: false, pending: null, followed: pending })).toBe("available");
  });

  it("takes the message of the offer when the result has none", () => {
    const offered = answer({ available: { ...update, failed: "unhealthy" }, last: { ...rolledBack, message: null } });
    expect(failure(offered.updater!)?.message).toBe("unhealthy");
  });
});

describe("installAction", () => {
  const attention = { ...update, version: "0.3.0" };

  it("installs an available update, and an attention offer only with its upgrade steps", () => {
    expect(installAction({ ...status, available: update }, update)).toBe("install");
    expect(installAction({ ...status, attention }, attention)).toBe("anyway");
  });

  it("offers no installation of an attention offer while the image tag decides (channelLocked)", () => {
    const locked = { ...status, mode: "platform" as const, channelLocked: "The platform's image tag 0.2 decides.", available: update, attention };
    expect(installAction(locked, attention)).toBe("locked");
    expect(installAction(locked, update)).toBe("install");
  });

  it("installs nothing while automatic updates are off", () => {
    expect(installAction({ ...status, mode: "off", attention }, attention)).toBe("off");
    expect(installAction({ ...status, mode: "off", available: update }, update)).toBe("off");
  });
});

describe("the install request", () => {
  const now = Date.parse("2026-11-19T09:00:05Z");
  const attempt: PendingInstall = { ...pending, confirmed: false };
  const otherInstalling = { version: "0.2.2", startedAt: "2026-11-19T08:59:00Z", manual: false, stage: "pulling" };

  it("follows the installation after 202", () => {
    const result = afterInstallRequest(attempt, { kind: "answer", httpStatus: 202, body: answer() }, now);
    expect(result).toEqual({ pending: { ...attempt, confirmed: true }, error: null });
  });

  it("keeps the attempt when the answer is unclear", () => {
    const timeout = "The update service at http://updater:8080 did not answer within 10 seconds.";
    const unreachable = { app: { version: "0.2.0" }, reachable: false, updater: null, error: timeout };
    expect(afterInstallRequest(attempt, { kind: "answer", httpStatus: 200, body: unreachable }, now)).toEqual({
      pending: { ...attempt, reason: timeout },
      error: null,
    });
    expect(afterInstallRequest(attempt, { kind: "outage" }, now)).toEqual({
      pending: { ...attempt, reason: "Logbook could not be reached." },
      error: null,
    });
  });

  it("forgets the attempt when the updater or Logbook refuses it", () => {
    const refused = { ...answer({ available: update }), error: "0.2.1 is not offered." };
    expect(afterInstallRequest(attempt, { kind: "answer", httpStatus: 409, body: refused }, now)).toEqual({
      pending: null,
      error: "0.2.1 is not offered.",
    });
    expect(afterInstallRequest(attempt, { kind: "error", message: "Send a version." }, now)).toEqual({ pending: null, error: "Send a version." });
  });

  it("follows the installation a refusal reports instead", () => {
    const busy = { ...answer({ installing: otherInstalling }), error: "0.2.2 is being installed." };
    expect(afterInstallRequest(attempt, { kind: "answer", httpStatus: 409, body: busy }, now)).toEqual({
      pending: { version: "0.2.2", startedAt: Date.parse(otherInstalling.startedAt), confirmed: true, sawOutage: false, reason: null },
      error: null,
    });
  });

  it("keeps an attempt that a status reported meanwhile", () => {
    const refused = { ...answer(), error: "0.2.1 is not offered." };
    expect(afterInstallRequest(pending, { kind: "answer", httpStatus: 409, body: refused }, now)).toEqual({ pending, error: null });
  });
});

describe("followInstall", () => {
  const attempt: PendingInstall = { ...pending, confirmed: false, reason: "Logbook could not be reached." };
  const installing = { version: "0.2.1", startedAt: "2026-11-19T09:00:01Z", manual: true, stage: "pulling" };
  const soon = pending.startedAt + 10_000;
  const later = pending.startedAt + 61_000;

  it("confirms an unclear attempt once the status reports it", () => {
    expect(followInstall(attempt, { kind: "answer", httpStatus: 200, body: answer({ installing }) }, soon)).toEqual({
      kind: "wait",
      pending: { ...attempt, confirmed: true },
      offline: false,
    });
    expect(followInstall(attempt, { kind: "answer", httpStatus: 200, body: answer({ last: rolledBack }) }, later)).toEqual({ kind: "failed" });
  });

  it("gives an unclear attempt a minute to show up, also through outages", () => {
    expect(followInstall(attempt, { kind: "answer", httpStatus: 200, body: answer() }, soon)).toMatchObject({ kind: "wait", offline: false });
    expect(followInstall(attempt, { kind: "outage" }, later)).toMatchObject({ kind: "wait", offline: true });
    expect(followInstall(attempt, { kind: "answer", httpStatus: 200, body: answer() }, later)).toEqual({
      kind: "not-started",
      reason: "Logbook could not be reached.",
    });
    const stale = answer({ last: { ...rolledBack, finishedAt: "2026-11-19T08:59:00Z" } });
    expect(followInstall(attempt, { kind: "answer", httpStatus: 200, body: stale }, later)).toMatchObject({ kind: "not-started" });
  });

  it("expects outages while Logbook restarts", () => {
    const noUpdater = { app: { version: "0.2.0" }, reachable: false, updater: null, error: "ENOTFOUND" };
    for (const result of [{ kind: "outage" as const }, { kind: "answer" as const, httpStatus: 200, body: noUpdater }]) {
      expect(followInstall(pending, result, soon)).toEqual({ kind: "wait", pending: { ...pending, sawOutage: true }, offline: true });
    }
  });

  it("stops polling when the session ended", () => {
    expect(followInstall(pending, { kind: "signed-out", message: "Not found." }, soon)).toEqual({ kind: "signed-out" });
  });

  it("follows the precedence of installOutcome once confirmed", () => {
    expect(followInstall(pending, { kind: "answer", httpStatus: 200, body: answer({ installing }, "0.2.1") }, soon)).toMatchObject({
      kind: "wait",
    });
    expect(followInstall(pending, { kind: "answer", httpStatus: 200, body: answer({}, "0.2.1") }, soon)).toEqual({ kind: "done" });
  });
});

describe("adoptInstall", () => {
  const now = Date.parse("2026-11-19T09:10:00Z");
  const automatic = { version: "0.2.1", startedAt: "2026-11-19T09:09:00Z", manual: false, stage: "pulling" };

  it("follows an installation the status reports, from its start", () => {
    expect(adoptInstall(null, answer({ installing: automatic }).updater, now)).toEqual({
      version: "0.2.1",
      startedAt: Date.parse(automatic.startedAt),
      confirmed: true,
      sawOutage: false,
      reason: null,
    });
    expect(adoptInstall(null, answer().updater, now)).toBeNull();
  });

  it("keeps the installation it follows, and confirms it", () => {
    expect(adoptInstall(pending, answer({ installing: automatic }).updater, now)).toBe(pending);
    expect(adoptInstall({ ...pending, confirmed: false }, answer({ installing: automatic }).updater, now)).toEqual(pending);
  });

  it("does not follow an installation the admin stopped waiting for", () => {
    expect(adoptInstall(null, answer({ installing: automatic }).updater, now, installKey(automatic))).toBeNull();
  });
});

describe("texts", () => {
  const now = Date.parse("2026-11-19T10:00:00Z");

  it("says how long ago", () => {
    expect(timeAgo("2026-11-19T09:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-11-19T09:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-11-19T09:00:00Z", now)).toBe("1 hour ago");
    expect(timeAgo("2026-11-19T07:00:00Z", now)).toBe("3 hours ago");
    expect(timeAgo("2026-11-18T04:00:00Z", now)).toBe("1 day ago");
    expect(timeAgo("2026-11-17T10:00:00Z", now)).toBe("2 days ago");
    expect(timeAgo("2026-11-19T10:05:00Z", now)).toBe("just now");
  });

  it("says when an update installs by itself", () => {
    const format = (value: Date) => value.toISOString();
    expect(installsAtText("2026-11-20T02:00:00Z", now, format)).toBe("Installs automatically on 2026-11-20T02:00:00.000Z");
    expect(installsAtText("2026-11-19T09:00:00Z", now, format)).toBe("Installs automatically at the next check");
    expect(installsAtText(null, now, format)).toBeNull();
  });

  it("counts the changes the popover leaves out", () => {
    expect(moreChanges(update, 8)).toBe(0);
    expect(moreChanges({ ...update, changes: 23 }, 8)).toBe(21);
    const many = { ...update, notes: Array.from({ length: 15 }, (_, i) => `Note ${i}`), changes: 15 };
    expect(moreChanges(many, 8)).toBe(7);
  });

  it.each([
    ["requested", "Waiting for the server"],
    ["pulling", "Downloading"],
    ["starting", "Starting"],
    ["rolling-back", "Going back to 0.2.0"],
    ["deploying", "Deploying"],
    ["verifying", "verifying"],
  ])("names the stage %s", (stage, label) => {
    expect(stageLabel(stage, "0.2.0")).toBe(label);
  });

  it.each([
    ["3d", "3 days"],
    ["1d", "1 day"],
    ["12h", "12 hours"],
    ["30m", "30 minutes"],
    ["3600", "1 hour"],
    ["90", "90 seconds"],
    ["45s", "45 seconds"],
    ["0", null],
    [null, null],
    ["1w", "1w"],
  ])("writes the duration %s as %s", (value, text) => {
    expect(durationText(value)).toBe(text);
  });

  it("describes the Stable channel with its cooldown", () => {
    expect(stableHelp("3d")).toBe("Releases. Updates that need no action install automatically after 3 days.");
    expect(stableHelp(null)).toBe("Releases. Updates that need no action install automatically.");
  });

  it("says whether and when updates install automatically", () => {
    expect(automaticText(status)).toBe("On: releases install automatically after 3 days, between 02:00 and 05:00 (UTC).");
    expect(automaticText({ ...status, window: null, cooldown: "0" })).toBe("On: releases install automatically.");
    expect(automaticText({ ...status, channel: "preview", cooldown: null, timezone: "Europe/Berlin" })).toBe(
      "On: releases and previews install automatically, between 02:00 and 05:00 (Europe/Berlin).",
    );
    expect(automaticText({ ...status, mode: "off", automatic: false })).toBe("Off on this server: nothing installs automatically.");
    expect(automaticText({ ...status, mode: "platform", window: null })).toBe(
      "On: releases install automatically after 3 days. The platform installs them (deploy link).",
    );
  });
});
