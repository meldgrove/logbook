import { describe, expect, it } from "vitest";
import {
  adoptInstall,
  afterInstallRequest,
  automaticText,
  buttonLabel,
  buttonState,
  checkError,
  durationText,
  failure,
  failureNote,
  followInstall,
  hasPopover,
  ignoreInstall,
  installAction,
  installOutcome,
  installsAtText,
  isIgnored,
  isOverdue,
  moreChanges,
  newAttempt,
  reconcileDeadline,
  reconcileEnd,
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
  installingSince: null,
  earlier: null,
  confirmed: true,
  sawOutage: false,
  reason: null,
  lastError: null,
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

  it("gives way to a newer offer, which keeps the failure as a line", () => {
    const newer = answer({ available: { ...update, version: "0.2.2" }, last: rolledBack });
    expect(buttonState(newer, { checking: false, pending: null, followed: pending })).toBe("available");
    expect(failureNote(newer.updater!, pending)).toBe(`0.2.1 failed: ${rolledBack.message}`);
    const attention = answer({ attention: { ...update, version: "0.3.0" }, last: rolledBack });
    expect(buttonState(attention, { checking: false, pending: null, followed: pending })).toBe("attention");
    expect(failureNote(attention.updater!, pending)).toBe(`0.2.1 failed: ${rolledBack.message}`);
    // While the failed version is still offered, the failure shows with Try again, and no line.
    const same = answer({ available: update, last: rolledBack });
    expect(buttonState(same, { checking: false, pending: null, followed: pending })).toBe("failed");
    expect(failureNote(same.updater!, pending)).toBeNull();
    // Without any offer, the failure itself shows.
    expect(buttonState(answer({ last: rolledBack }), { checking: false, pending: null, followed: pending })).toBe("failed");
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
  const attempt: PendingInstall = { ...pending, confirmed: false, lastError: "Logbook did not answer." };
  const otherInstalling = { version: "0.2.2", startedAt: "2026-11-19T08:59:00Z", manual: false, stage: "pulling" };

  it("remembers the attempt with the earlier result before the request", () => {
    const earlier = { ...rolledBack, finishedAt: "2026-11-19T08:30:00Z" };
    expect(newAttempt("0.2.1", pending.startedAt, answer({ last: earlier }))).toEqual({
      ...pending,
      confirmed: false,
      earlier,
      lastError: "Logbook did not answer.",
    });
    expect(newAttempt("0.2.1", pending.startedAt, null).earlier).toBeNull();
  });

  it("follows the installation after 202, also when its body cannot be read", () => {
    const result = afterInstallRequest(attempt, { kind: "answer", httpStatus: 202, body: answer() }, now);
    expect(result).toEqual({ pending: { ...attempt, confirmed: true }, error: null });
    const broken = { kind: "outage" as const, httpStatus: 202, message: "Logbook's answer could not be read." };
    expect(afterInstallRequest(attempt, broken, now)).toEqual({ pending: { ...attempt, confirmed: true }, error: null });
  });

  it("keeps the attempt when the answer is unclear", () => {
    const timeout = "The update service at http://updater:8080 did not answer within 10 seconds.";
    const unreachable = { app: { version: "0.2.0" }, reachable: false, updater: null, error: timeout };
    expect(afterInstallRequest(attempt, { kind: "answer", httpStatus: 200, body: unreachable }, now)).toEqual({
      pending: { ...attempt, reason: timeout, lastError: timeout },
      error: null,
    });
    for (const [httpStatus, message] of [
      [null, "Logbook could not be reached."],
      [503, "The update service answered HTTP 503."],
      [200, "Logbook's answer could not be read."],
    ] as const) {
      expect(afterInstallRequest(attempt, { kind: "outage", httpStatus, message }, now)).toEqual({
        pending: { ...attempt, reason: message, lastError: message },
        error: null,
      });
    }
  });

  it("forgets the attempt when the updater or Logbook refuses it", () => {
    const refused = { ...answer({ available: update }), error: "0.2.1 is not offered." };
    expect(afterInstallRequest(attempt, { kind: "answer", httpStatus: 409, body: refused }, now)).toEqual({
      pending: null,
      error: "0.2.1 is not offered.",
    });
    const badRequest = { kind: "error" as const, httpStatus: 400, message: "Send a version." };
    expect(afterInstallRequest(attempt, badRequest, now)).toEqual({ pending: null, error: "Send a version." });
    // A 4xx refuses even when its body cannot be read.
    const unreadable = { kind: "error" as const, httpStatus: 429, message: "Logbook answered HTTP 429." };
    expect(afterInstallRequest(attempt, unreadable, now)).toEqual({ pending: null, error: "Logbook answered HTTP 429." });
  });

  it("follows the installation a refusal reports instead", () => {
    const busy = { ...answer({ installing: otherInstalling }), error: "0.2.2 is being installed." };
    expect(afterInstallRequest(attempt, { kind: "answer", httpStatus: 409, body: busy }, now)).toEqual({
      pending: {
        version: "0.2.2",
        startedAt: Date.parse(otherInstalling.startedAt),
        installingSince: otherInstalling.startedAt,
        earlier: null,
        confirmed: true,
        sawOutage: false,
        reason: null,
        lastError: null,
      },
      error: null,
    });
  });

  it("keeps an attempt that a status reported meanwhile", () => {
    const refused = { ...answer(), error: "0.2.1 is not offered." };
    expect(afterInstallRequest(pending, { kind: "answer", httpStatus: 409, body: refused }, now)).toEqual({ pending, error: null });
  });
});

describe("followInstall", () => {
  const attempt: PendingInstall = { ...pending, confirmed: false, reason: "Logbook could not be reached.", lastError: "Logbook could not be reached." };
  const installing = { version: "0.2.1", startedAt: "2026-11-19T09:00:01Z", manual: true, stage: "pulling" };
  const ok = (response: UpdatesResponse) => ({ kind: "answer" as const, httpStatus: 200, body: response });
  const down = { kind: "outage" as const, httpStatus: null, message: "Logbook could not be reached." };

  it("confirms an unclear attempt once the status reports it, with the installation's identity", () => {
    expect(followInstall(attempt, ok(answer({ installing })))).toEqual({
      kind: "wait",
      pending: { ...attempt, confirmed: true, installingSince: installing.startedAt, lastError: null },
      offline: false,
    });
    expect(followInstall(attempt, ok(answer({ last: rolledBack })))).toMatchObject({ kind: "failed" });
  });

  it("takes a result of the same second as the attempt's start as fresh", () => {
    // The attempt started at 09:00:00.700; the updater writes whole seconds.
    const sameSecond = { ...attempt, startedAt: Date.parse("2026-11-19T09:00:00.700Z") };
    const accepted = { version: "0.2.1", result: "accepted" as const, message: null, finishedAt: "2026-11-19T09:00:00Z" };
    expect(followInstall(sameSecond, ok(answer({ last: accepted })))).toMatchObject({ kind: "wait", pending: { confirmed: true } });
    expect(followInstall(sameSecond, ok(answer({ last: accepted }, "0.2.1")))).toMatchObject({ kind: "done" });
    const failed = { ...rolledBack, finishedAt: "2026-11-19T09:00:00Z" };
    expect(followInstall(sameSecond, ok(answer({ last: failed })))).toMatchObject({ kind: "failed" });
  });

  it("does not take the earlier result as the result of a retry in the same second", () => {
    const earlier = { ...rolledBack, finishedAt: "2026-11-19T09:00:00Z" };
    const retry = newAttempt("0.2.1", Date.parse("2026-11-19T09:00:00.900Z"), answer({ available: update, last: earlier }));
    const step = followInstall(retry, ok(answer({ available: update, last: earlier })));
    expect(step).toMatchObject({ kind: "wait", pending: { confirmed: false, lastError: null } });
    expect(failure(answer({ last: earlier }).updater!, retry)).toBeNull();
    // A new result of the retry counts, also in the same second.
    const again = { ...earlier, message: "container web is unhealthy again.", result: "failed" as const };
    expect(followInstall(retry, ok(answer({ last: again })))).toMatchObject({ kind: "failed" });
  });

  it("counts results from the updater's start of the installation once it reported one", () => {
    const seen = { ...pending, startedAt: Date.parse("2026-11-19T09:00:03Z"), installingSince: "2026-11-19T09:00:01Z" };
    const installed = { version: "0.2.1", result: "installed" as const, message: null, finishedAt: "2026-11-19T09:00:02Z" };
    expect(followInstall(seen, ok(answer({ last: installed })))).toMatchObject({ kind: "done" });
    expect(followInstall(seen, ok(answer({ last: { ...installed, finishedAt: "2026-11-19T09:00:00Z" } })))).toMatchObject({
      kind: "wait",
    });
  });

  it("records every answer without a status as an outage, and a reachable status clears the error", () => {
    const noUpdater = { app: { version: "0.2.0" }, reachable: false, updater: null, error: "ENOTFOUND" };
    expect(followInstall(pending, down)).toEqual({
      kind: "wait",
      pending: { ...pending, sawOutage: true, lastError: "Logbook could not be reached." },
      offline: true,
    });
    expect(followInstall(pending, ok(noUpdater))).toEqual({
      kind: "wait",
      pending: { ...pending, sawOutage: true, lastError: "ENOTFOUND" },
      offline: true,
    });
    const bad = { kind: "outage" as const, httpStatus: 502, message: "Logbook answered HTTP 502." };
    expect(followInstall(attempt, bad)).toMatchObject({ pending: { sawOutage: true, lastError: "Logbook answered HTTP 502." } });
    expect(followInstall(attempt, ok(answer()))).toEqual({ kind: "wait", pending: { ...attempt, lastError: null }, offline: false });
  });

  it("completes a platform's deployment without an app version after reachable: false and a reachable answer", () => {
    const accepted = { version: "0.2.1", result: "accepted" as const, message: null, finishedAt: "2026-11-19T09:00:01Z" };
    const noUpdater = { app: { version: null }, reachable: false, updater: null, error: "ECONNREFUSED" };
    const first = followInstall(pending, ok(answer({ last: accepted }, null)));
    expect(first).toMatchObject({ kind: "wait", pending: { sawOutage: false } });
    const outage = followInstall(first.kind === "wait" ? first.pending : pending, ok(noUpdater));
    expect(outage).toMatchObject({ kind: "wait", offline: true, pending: { sawOutage: true } });
    const back = followInstall(outage.kind === "wait" ? outage.pending : pending, ok(answer({ last: accepted }, null)));
    expect(back).toMatchObject({ kind: "done" });
  });

  it("stops polling when the session ended", () => {
    expect(followInstall(pending, { kind: "signed-out", message: "Not found." })).toEqual({ kind: "signed-out" });
  });

  it("follows the precedence of installOutcome once confirmed", () => {
    expect(followInstall(pending, ok(answer({ installing }, "0.2.1")))).toMatchObject({ kind: "wait" });
    expect(followInstall(pending, ok(answer({}, "0.2.1")))).toEqual({ kind: "done", pending });
  });
});

describe("the deadline of an unconfirmed attempt", () => {
  const attempt: PendingInstall = { ...pending, confirmed: false, reason: "The update service did not answer within 10 seconds." };

  it("ends a minute after the attempt started; a page loaded later still asks for a moment", () => {
    expect(reconcileDeadline(attempt, attempt.startedAt)).toBe(attempt.startedAt + 60_000);
    expect(reconcileDeadline(attempt, attempt.startedAt + 120_000)).toBe(attempt.startedAt + 130_000);
  });

  it("did not start when a reachable status answered last without it", () => {
    expect(reconcileEnd({ ...attempt, lastError: null })).toEqual({
      kind: "not-started",
      reason: "The update service did not answer within 10 seconds.",
    });
    expect(reconcileEnd({ ...attempt, reason: null, lastError: null })).toEqual({
      kind: "not-started",
      reason: "The update service does not report it.",
    });
  });

  it("could not be confirmed when no status answered after the latest error", () => {
    expect(reconcileEnd({ ...attempt, lastError: "Logbook answered HTTP 502." })).toEqual({
      kind: "unconfirmed",
      error: "Logbook answered HTTP 502.",
    });
    expect(reconcileEnd(newAttempt("0.2.1", attempt.startedAt, null))).toEqual({ kind: "unconfirmed", error: "Logbook did not answer." });
  });

  it("offers to stop waiting after 15 minutes", () => {
    expect(isOverdue(pending, pending.startedAt + 15 * 60_000 - 1)).toBe(false);
    expect(isOverdue(pending, pending.startedAt + 15 * 60_000)).toBe(true);
  });
});

describe("adoptInstall", () => {
  const now = Date.parse("2026-11-19T09:10:00Z");
  const automatic = { version: "0.2.1", startedAt: "2026-11-19T09:09:00Z", manual: false, stage: "pulling" };

  it("follows an installation the status reports, from its start, with its identity and the earlier result", () => {
    const earlier = { ...rolledBack, finishedAt: "2026-11-19T08:00:00Z" };
    expect(adoptInstall(null, answer({ installing: automatic, last: earlier }).updater, now)).toEqual({
      version: "0.2.1",
      startedAt: Date.parse(automatic.startedAt),
      installingSince: automatic.startedAt,
      earlier,
      confirmed: true,
      sawOutage: false,
      reason: null,
      lastError: null,
    });
    expect(adoptInstall(null, answer().updater, now)).toBeNull();
  });

  it("keeps the installation it follows, confirms it, and stores its identity", () => {
    const seen = { ...pending, installingSince: automatic.startedAt };
    expect(adoptInstall(seen, answer({ installing: automatic }).updater, now)).toBe(seen);
    expect(adoptInstall({ ...pending, confirmed: false }, answer({ installing: automatic }).updater, now)).toEqual(seen);
  });

  it("does not follow an installation the admin stopped waiting for", () => {
    const stopped = ignoreInstall({ ...pending, installingSince: automatic.startedAt });
    expect(adoptInstall(null, answer({ installing: automatic }).updater, now, stopped)).toBeNull();
    // Another installation of the same version is followed.
    const later = { ...automatic, startedAt: "2026-11-19T09:20:00Z" };
    expect(adoptInstall(null, answer({ installing: later }).updater, now, stopped)).toMatchObject({ installingSince: later.startedAt });
  });

  it("ignores, without a reported identity, every installation of the version from the attempt's start on", () => {
    const stopped = ignoreInstall({ ...pending, startedAt: Date.parse("2026-11-19T09:00:00.600Z") });
    expect(isIgnored({ ...automatic, startedAt: "2026-11-19T09:00:00Z" }, stopped)).toBe(true);
    expect(isIgnored({ ...automatic, startedAt: "2026-11-19T08:59:59Z" }, stopped)).toBe(false);
    expect(isIgnored({ ...automatic, version: "0.2.2" }, stopped)).toBe(false);
    expect(isIgnored(automatic, null)).toBe(false);
  });
});

describe("checkError", () => {
  it("shows why a manual check failed, also when the updater cannot be reached", () => {
    expect(checkError(answer())).toBeNull();
    expect(checkError(answer({ error: "registry timeout" }))).toBe("The check failed: registry timeout");
    expect(checkError({ ...answer(), error: "A check runs already." })).toBe("A check runs already.");
    expect(checkError({ app: { version: "0.2.0" }, reachable: false, updater: null, error: "ENOTFOUND updater" })).toBe("ENOTFOUND updater");
    expect(checkError({ app: { version: "0.2.0" }, reachable: false, updater: null, error: null })).toBe("The update service is not reachable.");
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
