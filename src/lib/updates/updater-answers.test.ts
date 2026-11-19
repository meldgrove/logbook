import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buttonState, type ButtonState } from "./state";
import { createUpdaterClient } from "./updater-client";

/* Answers captured from Meldgrove Updater 0.2 (tests/fixtures/updater-0.2), as the API sends them. */

const FIXTURES = path.resolve(import.meta.dirname, "../../../tests/fixtures/updater-0.2");
const samples = readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));

function sample(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

function clientAnswering(name: string) {
  const httpStatus = name.startsWith("install-202") ? 202 : 200;
  return createUpdaterClient({
    url: "http://updater:8080",
    fetch: async () => new Response(sample(name), { status: httpStatus, headers: { "content-type": "application/json" } }),
  });
}

describe("the updater client", () => {
  it("has every sample", () => {
    expect(samples).toHaveLength(7);
  });

  it.each(samples)("takes %s as a status", async (name) => {
    const result = await clientAnswering(name).status();
    expect(result).toEqual({ kind: "ok", httpStatus: name.startsWith("install-202") ? 202 : 200, status: JSON.parse(sample(name)) });
  });

  it("keeps the 202 of an accepted installation", async () => {
    const result = await clientAnswering("install-202.json").install("0.1.3");
    expect(result).toMatchObject({ kind: "ok", httpStatus: 202, status: { installing: { version: "0.1.3", stage: "requested" } } });
  });
});

describe("buttonState of the samples", () => {
  it.each([
    ["status-off-available-attention.json", "available"],
    ["status-host-available.json", "available"],
    ["status-platform-locked.json", "up-to-date"],
    ["status-installing.json", "installing"],
    ["status-failed.json", "failed"],
    ["status-preview.json", "failed"],
    ["install-202.json", "installing"],
  ] satisfies [string, ButtonState][])("%s is %s", async (name, expected) => {
    const result = await clientAnswering(name).status();
    if (result.kind !== "ok") throw new Error(`${name} was not taken as a status`);
    const response = { app: { version: result.status.installed }, reachable: true, updater: result.status, error: null };
    expect(buttonState(response, { checking: false, pending: null })).toBe(expected);
  });
});
