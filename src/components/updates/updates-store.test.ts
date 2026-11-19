import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterInstallRequest, newAttempt } from "@/lib/updates/state";
import type { UpdaterStatus, UpdatesResponse } from "@/lib/updates/types";

type Store = typeof import("./updates-store");

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
const installing = { version: "0.2.1", startedAt: "2026-11-19T09:00:01Z", manual: true, stage: "pulling" };

function answer(change: Partial<UpdaterStatus> = {}): UpdatesResponse {
  return { app: { version: "0.2.0" }, reachable: true, updater: { ...status, ...change }, error: null };
}
const unreachable: UpdatesResponse = { app: { version: "0.2.0" }, reachable: false, updater: null, error: "ECONNREFUSED" };

/** sessionStorage of one tab: survives a reload (a fresh store module). */
let storage: Map<string, string>;
let store: Store;

async function loadPage(): Promise<Store> {
  vi.resetModules();
  store = await import("./updates-store");
  return store;
}

beforeEach(async () => {
  storage = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  await loadPage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stop waiting", () => {
  it("ignores the stored installation when the updater returns after being unreachable", async () => {
    store.receiveUpdates(answer({ installing }));
    expect(store.currentUpdates().pending).toMatchObject({ version: "0.2.1", installingSince: installing.startedAt });
    store.receiveUpdates(unreachable);
    store.stopWaiting();
    expect(store.currentUpdates().pending).toBeNull();

    store.receiveUpdates(answer({ installing }));
    expect(store.currentUpdates().pending).toBeNull();
    // Also after a reload.
    await loadPage();
    store.receiveUpdates(answer({ installing }));
    expect(store.currentUpdates().pending).toBeNull();
    // Another installation is followed.
    store.receiveUpdates(answer({ installing: { ...installing, version: "0.2.2" } }));
    expect(store.currentUpdates().pending).toMatchObject({ version: "0.2.2" });
  });

  it("ignores an attempt no status reported by its version and start", () => {
    const attempt = newAttempt("0.2.1", Date.parse("2026-11-19T09:00:00.400Z"), answer());
    store.setUpdates({ pending: attempt });
    store.receiveUpdates(unreachable);
    store.stopWaiting();
    store.receiveUpdates(answer({ installing: { ...installing, startedAt: "2026-11-19T09:00:00Z" } }));
    expect(store.currentUpdates().pending).toBeNull();
  });
});

describe("automatic status requests", () => {
  it("stop after a sign-in redirect and keep the attempt", async () => {
    const attempt = newAttempt("0.2.1", Date.now(), answer());
    store.setUpdates({ pending: attempt });
    const request = vi.fn<Store["requestUpdates"]>(async () => ({ kind: "signed-out", message: "Your session ended." }));
    await store.pollUpdates(request);
    expect(store.currentUpdates()).toMatchObject({ signedOut: true, pending: attempt });
    await store.pollUpdates(request);
    expect(request).toHaveBeenCalledTimes(1);
    // The next page load finds the attempt.
    await loadPage();
    expect(store.currentUpdates()).toMatchObject({ signedOut: false, pending: attempt });
  });

  it("show the answer and follow an installation it reports", async () => {
    await store.pollUpdates(async () => ({ kind: "answer", httpStatus: 200, body: answer({ installing }) }));
    expect(store.currentUpdates().pending).toMatchObject({ version: "0.2.1", confirmed: true });
  });
});

describe("requestUpdates", () => {
  function answering(response: Response | (() => Promise<Response>)) {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => (typeof response === "function" ? response() : response));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  const jsonAnswer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("takes an answer with a status, also a refusal", async () => {
    answering(jsonAnswer(409, { ...answer(), error: "0.2.1 is not offered." }));
    expect(await store.requestUpdates("install", { version: "0.2.1" })).toEqual({
      kind: "answer",
      httpStatus: 409,
      body: { ...answer(), error: "0.2.1 is not offered." },
    });
  });

  it("keeps the 202 of an answer whose body broke off, which confirms the installation", async () => {
    answering(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"app":'));
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await store.requestUpdates("install", { version: "0.2.1" });
    expect(result).toEqual({ kind: "outage", httpStatus: 202, message: "Logbook's answer could not be read." });
    const attempt = newAttempt("0.2.1", Date.now(), answer());
    expect(afterInstallRequest(attempt, result, Date.now())).toEqual({ pending: { ...attempt, confirmed: true }, error: null });
  });

  it("takes a 5xx and an unreadable answer as unclear, and a 4xx as a refusal", async () => {
    answering(jsonAnswer(503, { ...unreachable, error: "The update service answered HTTP 503." }));
    expect(await store.requestUpdates("install", { version: "0.2.1" })).toEqual({
      kind: "outage",
      httpStatus: 503,
      message: "The update service answered HTTP 503.",
    });
    answering(new Response("Bad Gateway", { status: 502 }));
    expect(await store.requestUpdates("status")).toEqual({ kind: "outage", httpStatus: 502, message: "Logbook answered HTTP 502." });
    answering(jsonAnswer(200, { ok: true }));
    expect(await store.requestUpdates("status")).toMatchObject({ kind: "outage", httpStatus: 200 });
    // A proxy's 404 is no sign of an ended session.
    answering(new Response("404 page not found", { status: 404, headers: { "content-type": "text/plain" } }));
    expect(await store.requestUpdates("status")).toMatchObject({ kind: "error", httpStatus: 404 });
    answering(new Response("Too Many Requests", { status: 429 }));
    expect(await store.requestUpdates("install", { version: "0.2.1" })).toEqual({
      kind: "error",
      httpStatus: 429,
      message: "Logbook answered HTTP 429.",
    });
  });

  it("takes a sign-in page, 401, 403, and Logbook's 404 as the end of the session", async () => {
    answering(new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await store.requestUpdates("status")).toMatchObject({ kind: "signed-out" });
    const redirected = jsonAnswer(200, answer());
    Object.defineProperty(redirected, "redirected", { value: true });
    answering(redirected);
    expect(await store.requestUpdates("status")).toMatchObject({ kind: "signed-out" });
    for (const status of [401, 403, 404]) {
      answering(jsonAnswer(status, { error: "Not found." }));
      expect(await store.requestUpdates("status")).toMatchObject({ kind: "signed-out" });
    }
  });

  it("gives up after the timeout", async () => {
    answering(async () => new Promise<Response>(() => {})).mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    expect(await store.requestUpdates("status", undefined, { timeoutMs: 50 })).toEqual({
      kind: "outage",
      httpStatus: null,
      message: "Logbook did not answer within 1 second.",
    });
  });
});
