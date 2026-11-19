import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUpdatesService } from "./service";
import type { UpdaterStatus } from "./types";
import { createUpdaterClient, UPDATER_TIMEOUTS, type UpdaterTimeouts } from "./updater-client";

const STATUS: UpdaterStatus = {
  updater: "0.2.0",
  mode: "host",
  channel: "stable",
  channelLocked: null,
  installed: "0.2.0",
  available: {
    version: "0.2.1",
    preview: false,
    publishedAt: "2026-11-17T10:00:00Z",
    url: "https://github.com/meldgrove/logbook/releases/tag/v0.2.1",
    notes: ["Fix the sign-in loop"],
    changes: 1,
    installsAt: "2026-11-20T02:00:00Z",
    failed: null,
  },
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

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void;

/** A stand-in for the updater: each test sets how it answers. */
let handler: Handler;
const requests: { method: string; path: string; body: string }[] = [];
let server: Server;
let url: string;

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method!, path: request.url!, body });
    handler(request, body, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  requests.length = 0;
  handler = (_request, _body, response) => json(response, 200, STATUS);
});

const fast: UpdaterTimeouts = { status: 200, check: 200, install: 200, channel: 200 };
const service = (timeouts: UpdaterTimeouts = UPDATER_TIMEOUTS) =>
  createUpdatesService({ client: createUpdaterClient({ url, timeouts }), appVersion: "0.2.0" });

describe("updates service", () => {
  it("uses the timeouts of the contract", () => {
    expect(UPDATER_TIMEOUTS).toEqual({ status: 3_000, check: 35_000, install: 10_000, channel: 35_000 });
  });

  it("answers with the updater's status and the app's version", async () => {
    const reply = await service().status();
    expect(reply).toEqual({
      httpStatus: 200,
      body: { app: { version: "0.2.0" }, reachable: true, updater: STATUS, error: null },
    });
    expect(requests).toEqual([{ method: "GET", path: "/v1/status", body: "" }]);
  });

  it("passes the version, the channel, and 202 for a started installation", async () => {
    handler = (request, _body, response) =>
      json(response, request.url === "/v1/install" ? 202 : 200, { ...STATUS, installing: null });
    expect((await service().install("0.2.1")).httpStatus).toBe(202);
    expect((await service().channel("preview")).httpStatus).toBe(200);
    expect((await service().check()).httpStatus).toBe(200);
    expect(requests.map((r) => `${r.method} ${r.path} ${r.body}`)).toEqual([
      'POST /v1/install {"version":"0.2.1"}',
      'POST /v1/channel {"channel":"preview"}',
      "POST /v1/check ",
    ]);
  });

  it("turns an error answer of the updater into 409 with the error and the latest status", async () => {
    handler = (request, _body, response) =>
      request.url === "/v1/install"
        ? json(response, 409, { error: "0.2.1 is not offered; check again." })
        : json(response, 200, STATUS);
    const reply = await service().install("0.2.1");
    expect(reply).toEqual({
      httpStatus: 409,
      body: { app: { version: "0.2.0" }, reachable: true, updater: STATUS, error: "0.2.1 is not offered; check again." },
    });
    expect(requests.map((r) => r.path)).toEqual(["/v1/install", "/v1/status"]);
  });

  it("passes a 5xx answer to an install request through, with the error and the latest status", async () => {
    handler = (request, _body, response) =>
      request.url === "/v1/install" ? json(response, 503, { error: "The deploy trigger is busy." }) : json(response, 200, STATUS);
    expect(await service().install("0.2.1")).toEqual({
      httpStatus: 503,
      body: { app: { version: "0.2.0" }, reachable: true, updater: STATUS, error: "The deploy trigger is busy." },
    });
    handler = (_request, _body, response) => json(response, 500, {});
    expect(await service().install("0.2.1")).toMatchObject({ httpStatus: 500, body: { error: "The update service answered HTTP 500." } });
    // A check or a channel change was refused: 409 with the error.
    expect((await service().check()).httpStatus).toBe(409);
  });

  it("answers 409 for a locked channel and an error answer without a message", async () => {
    handler = (request, _body, response) =>
      request.url === "/v1/channel" ? json(response, 409, { error: "The platform's image tag decides." }) : json(response, 500, {});
    const reply = await service().channel("preview");
    expect(reply.httpStatus).toBe(409);
    expect(reply.body).toMatchObject({ reachable: true, updater: null, error: "The platform's image tag decides." });

    handler = (_request, _body, response) => json(response, 400, "not json with an error");
    expect((await service().check()).body.error).toBe("The update service answered HTTP 400.");
  });

  it("answers reachable: false when nothing listens at UPDATER_URL", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = createUpdatesService({
      client: createUpdaterClient({ url: `http://127.0.0.1:${port}` }),
      appVersion: null,
    });
    for (const reply of [await unreachable.status(), await unreachable.install("0.2.1")]) {
      expect(reply.httpStatus).toBe(200);
      expect(reply.body).toMatchObject({ app: { version: null }, reachable: false, updater: null });
      expect(reply.body.error).toMatch(/cannot be reached: .*ECONNREFUSED/);
    }
  });

  it("gives up after the timeout and answers reachable: false", async () => {
    handler = (_request, _body, response) => setTimeout(() => json(response, 200, STATUS), 1_000);
    const started = Date.now();
    const reply = await service(fast).check();
    expect(Date.now() - started).toBeLessThan(900);
    expect(reply).toMatchObject({ httpStatus: 200, body: { reachable: false, updater: null } });
    expect(reply.body.error).toMatch(/did not answer within 0.2 seconds/);
  });

  it("does not take another service's answer for a status", async () => {
    handler = (_request, _body, response) => json(response, 200, { status: "ok" });
    expect((await service().status()).body).toMatchObject({ reachable: false, updater: null });
    handler = (_request, _body, response) => json(response, 404, { error: "Not found." });
    expect((await service().status()).body).toMatchObject({ reachable: false, updater: null, error: "Not found." });
  });

  it("calls nothing when UPDATER_URL is empty", async () => {
    const off = createUpdatesService({ client: null, appVersion: "0.2.0" });
    expect(await off.status()).toEqual({
      httpStatus: 200,
      body: { app: { version: "0.2.0" }, reachable: false, updater: null, error: "UPDATER_URL is empty, so the update service is off." },
    });
    expect((await off.install("0.2.1")).body.reachable).toBe(false);
    expect(requests).toEqual([]);
  });
});
