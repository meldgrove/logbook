import { startFakeUpdater, updaterStatus, type FakeUpdater } from "@meldgrove/ui/updates/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { POST as check } from "./check/route";
import { POST as install } from "./install/route";
import { POST as channel } from "./channel/route";

/*
 * The four routes with Logbook's real access check and the package's handler,
 * against a fake updater that requires a token, as the updater does with
 * API_TOKEN set. What the package answers in each case is tested there.
 */

const TOKEN = "updater-token-for-tests";

const mocks = vi.hoisted(() => ({
  /** The person behind the session; null: no session. */
  person: vi.fn(),
  updater: { UPDATER_URL: null as string | null, UPDATER_TOKEN: undefined as string | undefined },
}));
// The real access check in src/lib/auth/session.ts, with the request's session stubbed.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/auth", () => ({
  getLogbookAuth: () => ({
    requestSession: async () => {
      const person = await mocks.person();
      if (!person) return { status: "none" };
      return person.hasAccess ? { status: "active", userId: "user", person } : { status: "ended" };
    },
  }),
}));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getAuthConfig: () => ({ LOGBOOK_BASE_URL: "https://logbook.example.org" }),
  getUpdaterConfig: () => mocks.updater,
  getVersionConfig: () => ({ APP_VERSION: "0.2.0" }),
}));

const BASE = "https://logbook.example.org/api/admin/updates";
const ADMIN = { id: "admin", hasAccess: true, isAdmin: true };
const MEMBER = { id: "member", hasAccess: true, isAdmin: false };
const FORMER_ADMIN = { id: "former", hasAccess: false, isAdmin: true };

function post(path: string, body?: unknown, origin: string | null = "https://logbook.example.org"): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let updater: FakeUpdater;

beforeAll(async () => {
  updater = await startFakeUpdater({ token: TOKEN });
});

afterAll(async () => {
  await updater.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.person.mockResolvedValue(ADMIN);
  mocks.updater.UPDATER_URL = updater.url;
  mocks.updater.UPDATER_TOKEN = TOKEN;
  updater.calls.length = 0;
  updater.respond(() => ({ body: updaterStatus() }));
});

const routes = [
  ["GET /updates", () => GET(new Request(BASE))],
  ["POST /updates/check", () => check(post("/check"))],
  ["POST /updates/install", () => install(post("/install", { version: "0.2.1" }))],
  ["POST /updates/channel", () => channel(post("/channel", { channel: "preview" }))],
] as const;

describe("/api/admin/updates", () => {
  it.each(routes)("%s answers 404 to people who are not admins and without a session", async (_name, call) => {
    for (const person of [MEMBER, FORMER_ADMIN, null]) {
      mocks.person.mockResolvedValue(person);
      const response = await call();
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(updater.calls).toEqual([]);
  });

  it("answers admins with the updater's status, asked with UPDATER_TOKEN", async () => {
    const response = await GET(new Request(BASE));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ app: { version: "0.2.0" }, reachable: true, updater: updaterStatus(), error: null });
    expect(updater.calls).toEqual([{ method: "GET", path: "/v1/status", body: null, authorization: `Bearer ${TOKEN}` }]);
  });

  it("passes check, install, and channel on to the updater with the token", async () => {
    const installing = updaterStatus({ installing: { version: "0.2.1", startedAt: "2026-11-24T10:00:00.000Z", manual: true, stage: "requested" } });
    updater.respond((call) => (call.path === "/v1/install" ? { status: 202, body: installing } : { body: updaterStatus() }));

    expect((await check(post("/check"))).status).toBe(200);
    const response = await install(post("/install", { version: "0.2.1" }));
    expect(response.status).toBe(202);
    expect((await response.json()).updater).toEqual(installing);
    expect((await channel(post("/channel", { channel: "preview" }))).status).toBe(200);

    expect(updater.calls).toEqual([
      { method: "POST", path: "/v1/check", body: null, authorization: `Bearer ${TOKEN}` },
      { method: "POST", path: "/v1/install", body: { version: "0.2.1" }, authorization: `Bearer ${TOKEN}` },
      { method: "POST", path: "/v1/channel", body: { channel: "preview" }, authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it("without UPDATER_TOKEN, asks an updater that needs none without a token, as before", async () => {
    const open = await startFakeUpdater();
    try {
      mocks.updater.UPDATER_URL = open.url;
      mocks.updater.UPDATER_TOKEN = undefined;
      const response = await GET(new Request(BASE));
      expect(response.status).toBe(200);
      expect((await response.json()).updater).toEqual(updaterStatus({ apiToken: false }));
      expect(open.calls).toEqual([{ method: "GET", path: "/v1/status", body: null, authorization: null }]);
    } finally {
      await open.close();
    }
  });

  it.each([
    ["another site", "https://evil.example"],
    ["no Origin header", null],
    ["the same host on another port", "https://logbook.example.org:8443"],
  ])("refuses a POST from %s with 403", async (_name, origin) => {
    for (const call of [
      () => check(post("/check", undefined, origin)),
      () => install(post("/install", { version: "0.2.1" }, origin)),
      () => channel(post("/channel", { channel: "preview" }, origin)),
    ]) {
      expect((await call()).status).toBe(403);
    }
    expect(updater.calls).toEqual([]);
  });

  it("refuses a version that is not one with 400, without asking the updater", async () => {
    const response = await install(post("/install", { version: "latest" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/version/);
    expect(updater.calls).toEqual([]);
  });
});
