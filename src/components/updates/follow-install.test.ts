import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterInstallRequest, newAttempt, type PendingInstall } from "@/lib/updates/state";
import type { UpdaterStatus, UpdatesRequestResult, UpdatesResponse } from "@/lib/updates/types";
import type { FollowEnd } from "./follow-install";

type Store = typeof import("./updates-store");
type Request = Store["requestUpdates"];

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
  window: null,
  timezone: "UTC",
};

function body(change: Partial<UpdaterStatus> = {}, app: string | null = "0.2.0"): UpdatesResponse {
  return { app: { version: app }, reachable: true, updater: { ...status, ...change }, error: null };
}
function answer(change: Partial<UpdaterStatus> = {}, app: string | null = "0.2.0"): UpdatesRequestResult {
  return { kind: "answer", httpStatus: 200, body: body(change, app) };
}
const down: UpdatesRequestResult = { kind: "outage", httpStatus: null, message: "Logbook could not be reached." };
const timeout = "The update service at http://updater:8080 did not answer within 10 seconds.";

let store: Store;
let followPending: typeof import("./follow-install").followPending;
let ends: FollowEnd[];
let stop: () => void;

/** Starts following an install request that got the unclear answer `posted`. */
function follow(request: Request, posted: UpdatesRequestResult = down): PendingInstall {
  const attempt = afterInstallRequest(newAttempt("0.2.1", Date.now(), null), posted, Date.now()).pending!;
  store.setUpdates({ pending: attempt });
  stop = followPending((end) => ends.push(end), request);
  return attempt;
}

beforeEach(async () => {
  vi.useFakeTimers({ now: Date.parse("2026-11-19T09:00:00.500Z") });
  vi.resetModules();
  store = await import("./updates-store");
  ({ followPending } = await import("./follow-install"));
  ends = [];
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe("following an unconfirmed attempt", () => {
  it("ends at the deadline while every poll fails, with the last error, and bounds each poll by the time left", async () => {
    const request = vi.fn<Request>(async () => ({ kind: "outage", httpStatus: 502, message: "Logbook answered HTTP 502." }));
    follow(request);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ends).toEqual([]);
    expect(store.currentUpdates()).toMatchObject({ offline: true, pending: { sawOutage: true } });
    await vi.advanceTimersByTimeAsync(1);
    expect(ends).toEqual([{ kind: "unconfirmed", error: "Logbook answered HTTP 502." }]);
    expect(store.currentUpdates().pending).toBeNull();
    for (const [, , options] of request.mock.calls) expect(options!.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(request.mock.calls.at(-1)![2]!.timeoutMs).toBeLessThanOrEqual(2_000);
    const calls = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(calls);
  });

  it("ends at the deadline while a poll never returns", async () => {
    const request = vi.fn<Request>(() => new Promise(() => {}));
    follow(request);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ends).toEqual([{ kind: "unconfirmed", error: "Logbook could not be reached." }]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("did not start when a reachable status answered without it at the deadline", async () => {
    const request = vi.fn<Request>(async () => answer());
    follow(request, { kind: "answer", httpStatus: 200, body: { app: { version: "0.2.0" }, reachable: false, updater: null, error: timeout } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ends).toEqual([{ kind: "not-started", reason: timeout }]);
  });

  it("follows the attempt once the status reports it, past the deadline", async () => {
    const installing = { version: "0.2.1", startedAt: "2026-11-19T09:00:01Z", manual: true, stage: "pulling" };
    const request = vi.fn<Request>(async () => answer({ installing }));
    follow(request);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.currentUpdates().pending).toMatchObject({ confirmed: true, installingSince: installing.startedAt });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ends).toEqual([]);
    const installed = { version: "0.2.1", result: "installed" as const, message: null, finishedAt: "2026-11-19T09:02:30Z" };
    request.mockImplementation(async () => answer({ last: installed }, "0.2.1"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ends).toEqual([{ kind: "done", version: "0.2.1" }]);
    expect(store.currentUpdates().pending).toBeNull();
  });
});

describe("following a confirmed installation", () => {
  it("stops every request after a sign-in redirect and keeps the attempt", async () => {
    const request = vi.fn<Request>(async () => ({ kind: "signed-out", message: "Your session ended." }));
    const attempt = follow(request, { kind: "outage", httpStatus: 202, message: "Logbook's answer could not be read." });
    expect(attempt.confirmed).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ends).toEqual([{ kind: "signed-out" }]);
    expect(store.currentUpdates()).toMatchObject({ signedOut: true, pending: attempt });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(ends).toHaveLength(1);
  });

  it("makes no request once another request of the page found the session ended", async () => {
    const request = vi.fn<Request>(async () => answer());
    follow(request, { kind: "answer", httpStatus: 202, body: body() });
    store.setUpdates({ signedOut: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ends).toEqual([{ kind: "signed-out" }]);
    expect(request).not.toHaveBeenCalled();
    expect(store.currentUpdates().pending).not.toBeNull();
  });

  it("offers Stop waiting after 15 minutes, also while no poll returns", async () => {
    follow(vi.fn<Request>(() => new Promise(() => {})), { kind: "answer", httpStatus: 202, body: body() });
    const before = store.currentUpdates().at;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const { at, pending } = store.currentUpdates();
    expect(at - before).toBe(15 * 60_000);
    expect(at - pending!.startedAt).toBeGreaterThanOrEqual(15 * 60_000);
  });
});
