import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import { startDispatcher } from "./dispatch";

afterEach(() => {
  vi.restoreAllMocks();
});

/** One dispatcher run against a database whose transactions end as `transaction` says. */
async function runOnce(transaction: () => Promise<unknown>, connectionError: boolean) {
  const outage = { failed: vi.fn(() => connectionError), answered: vi.fn() };
  const db = { transaction } as unknown as Database;
  const stop = startDispatcher({ db, transports: async () => ({ baseUrl: "http://localhost:3000" }), intervalMs: 60_000, outage });
  await stop();
  return outage;
}

describe("startDispatcher", () => {
  it("tells the outage watch that the database answered", async () => {
    const outage = await runOnce(async () => null, false);
    expect(outage.answered).toHaveBeenCalledTimes(1);
  });

  it("leaves a connection error to the outage watch", async () => {
    const error = vi.spyOn(logger, "error");
    const terminated = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    const outage = await runOnce(() => Promise.reject(terminated), true);
    expect(outage.failed).toHaveBeenCalledWith(terminated, "notification dispatch");
    expect(error).not.toHaveBeenCalled();
  });

  it("still logs any other error as an error", async () => {
    const error = vi.spyOn(logger, "error");
    const outage = await runOnce(() => Promise.reject(new Error("boom")), false);
    expect(outage.answered).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith({ error: "boom" }, "notification dispatch failed");
  });
});
