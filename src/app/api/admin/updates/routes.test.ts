import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdatesService } from "@/lib/updates/service";
import { GET } from "./route";
import { POST as check } from "./check/route";
import { POST as install } from "./install/route";
import { POST as channel } from "./channel/route";

const mocks = vi.hoisted(() => ({
  /** The person behind the session; null: no session. */
  person: vi.fn(),
  service: {
    status: vi.fn(),
    check: vi.fn(),
    install: vi.fn(),
    channel: vi.fn(),
  } satisfies Record<keyof UpdatesService, unknown>,
}));
// The real access check in src/lib/auth/session.ts, with the session and the person stubbed.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => {
        const person = await mocks.person();
        return person ? { session: { id: "session", oidcSubject: person.id }, user: { id: "user" } } : null;
      },
    },
  }),
}));
vi.mock("@/lib/directory/queries", () => ({ findPersonBySubject: async () => mocks.person() }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getAuthConfig: () => ({ LOGBOOK_BASE_URL: "https://logbook.example.org" }),
}));
vi.mock("@/lib/updates/service", () => ({ getUpdatesService: () => mocks.service }));

const BASE = "https://logbook.example.org/api/admin/updates";
const ADMIN = { id: "admin", hasAccess: true, isAdmin: true };
const MEMBER = { id: "member", hasAccess: true, isAdmin: false };
const FORMER_ADMIN = { id: "former", hasAccess: false, isAdmin: true };
const ANSWER = { app: { version: "0.2.0" }, reachable: true, updater: null, error: null };

function post(path: string, body?: unknown, origin: string | null = "https://logbook.example.org"): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.person.mockResolvedValue(ADMIN);
  for (const call of Object.values(mocks.service)) call.mockResolvedValue({ httpStatus: 200, body: ANSWER });
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
    }
    for (const method of Object.values(mocks.service)) expect(method).not.toHaveBeenCalled();
  });

  it.each(routes)("%s answers admins with the service's reply", async (_name, call) => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(ANSWER);
  });

  it("passes 202, 409, and the request's values through", async () => {
    mocks.service.install.mockResolvedValue({ httpStatus: 202, body: ANSWER });
    expect((await install(post("/install", { version: "0.2.1-preview.3" }))).status).toBe(202);
    expect(mocks.service.install).toHaveBeenCalledWith("0.2.1-preview.3");

    const refused = { ...ANSWER, error: "The platform's image tag decides." };
    mocks.service.channel.mockResolvedValue({ httpStatus: 409, body: refused });
    const response = await channel(post("/channel", { channel: "stable" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(refused);
    expect(mocks.service.channel).toHaveBeenCalledWith("stable");

    await install(post("/install", { version: "sha256:0123456789ab" }));
    expect(mocks.service.install).toHaveBeenLastCalledWith("sha256:0123456789ab");
  });

  it("passes a 5xx of the install request through, never as 409", async () => {
    const failed = { ...ANSWER, error: "The update service answered HTTP 503." };
    mocks.service.install.mockResolvedValue({ httpStatus: 503, body: failed });
    const response = await install(post("/install", { version: "0.2.1" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(failed);
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
    for (const method of Object.values(mocks.service)) expect(method).not.toHaveBeenCalled();
  });

  it.each([
    [{ version: "latest" }],
    [{ version: "0.2" }],
    [{ version: "0.2.1-rc.1" }],
    [{ version: "0.2.1; rm -rf /" }],
    [{ version: "sha256:0123456789abcdef" }],
    [{ version: 21 }],
    [{}],
    ["not json"],
    [undefined],
  ])("refuses to install %j with 400", async (body) => {
    const response = await install(post("/install", body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/version/);
    expect(mocks.service.install).not.toHaveBeenCalled();
  });

  it.each([[{ channel: "beta" }], [{ channel: "Stable" }], [{}], ["{"]])("refuses the channel %j with 400", async (body) => {
    const response = await channel(post("/channel", body));
    expect(response.status).toBe(400);
    expect(mocks.service.channel).not.toHaveBeenCalled();
  });
});
