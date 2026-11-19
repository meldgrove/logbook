import { describe, expect, it } from "vitest";
import {
  automaticText,
  buttonLabel,
  buttonState,
  durationText,
  hasPopover,
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
  fromVersion: "0.2.0",
  previousResult: null,
  startedAt: Date.parse("2026-11-19T09:00:00Z"),
  sawOutage: false,
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
    ["off", answer({ mode: "off", automatic: false, available: update }), idle],
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
  it("is done when Logbook runs the version", () => {
    expect(installOutcome(pending, answer({}, "0.2.1"))).toBe("done");
  });

  it("is done when the server installed it, even without a version of its own (development)", () => {
    const installed = { version: "0.2.1", result: "installed" as const, message: null, finishedAt: "2026-11-19T09:02:00Z" };
    expect(installOutcome(pending, answer({ last: installed }, null))).toBe("done");
    expect(installOutcome({ ...pending, fromVersion: null }, answer({ last: installed }, null))).toBe("done");
  });

  it("waits for a platform's deployment until Logbook runs another version or restarted", () => {
    const accepted = { version: "0.2.1", result: "accepted" as const, message: null, finishedAt: "2026-11-19T09:00:01Z" };
    expect(installOutcome(pending, answer({ last: accepted }))).toBe("waiting");
    expect(installOutcome({ ...pending, sawOutage: true }, answer({ last: accepted }))).toBe("done");
    expect(installOutcome(pending, answer({ last: accepted }, "sha256:0123456789ab"))).toBe("done");
  });

  it("fails when the server failed or went back", () => {
    expect(installOutcome(pending, answer({ last: rolledBack }))).toBe("failed");
    expect(installOutcome(pending, answer({ last: { ...rolledBack, result: "failed" } }))).toBe("failed");
  });

  it("ignores results of other versions and the result from before this installation", () => {
    expect(installOutcome(pending, answer({ last: { ...rolledBack, version: "0.2.2" } }))).toBe("waiting");
    expect(installOutcome({ ...pending, previousResult: rolledBack.finishedAt }, answer({ last: rolledBack }))).toBe("waiting");
    const running = { version: "0.2.1", startedAt: "2026-11-19T09:00:00Z", manual: true, stage: "pulling" };
    expect(installOutcome(pending, answer({ installing: running }))).toBe("waiting");
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
