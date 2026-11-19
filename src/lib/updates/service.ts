import { getUpdaterConfig, getVersionConfig } from "@/lib/config";
import { createUpdaterClient, type UpdaterCallResult, type UpdaterClient } from "./updater-client";
import type { Channel, UpdatesResponse } from "./types";

/*
 * What the routes under /api/admin/updates answer, for admins only:
 *
 * - the updater's status: 200 (202 after an install request);
 * - an error answer of the updater: 409 with `error` and the latest status;
 * - no updater at UPDATER_URL, or UPDATER_URL empty: 200 with
 *   `reachable: false`.
 */

export interface UpdatesReply {
  httpStatus: number;
  body: UpdatesResponse;
}

export interface UpdatesService {
  status(): Promise<UpdatesReply>;
  check(): Promise<UpdatesReply>;
  install(version: string): Promise<UpdatesReply>;
  channel(channel: Channel): Promise<UpdatesReply>;
}

export function createUpdatesService(options: { client: UpdaterClient | null; appVersion: string | null }): UpdatesService {
  const { client } = options;
  const app = { version: options.appVersion };

  const unreachable = (error: string | null): UpdatesReply => ({
    httpStatus: 200,
    body: { app, reachable: false, updater: null, error },
  });

  async function reply(result: UpdaterCallResult): Promise<UpdatesReply> {
    switch (result.kind) {
      case "ok":
        return { httpStatus: result.httpStatus, body: { app, reachable: true, updater: result.status, error: null } };
      case "unreachable":
        return unreachable(result.error);
      case "refused": {
        // The updater refused (e.g. the version is no longer offered): show why, with its latest status.
        const latest = await client!.status();
        return {
          httpStatus: 409,
          body: { app, reachable: true, updater: latest.kind === "ok" ? latest.status : null, error: result.error },
        };
      }
    }
  }

  const off = () => unreachable("UPDATER_URL is empty, so the update service is off.");

  async function run(call: (client: UpdaterClient) => Promise<UpdaterCallResult>): Promise<UpdatesReply> {
    return client ? reply(await call(client)) : off();
  }

  return {
    async status() {
      if (!client) return off();
      const result = await client.status();
      // The status never fails on a working updater; an error answer means another service answers there.
      return result.kind === "refused" ? unreachable(result.error) : reply(result);
    },
    check: () => run((c) => c.check()),
    install: (version) => run((c) => c.install(version)),
    channel: (channel) => run((c) => c.channel(channel)),
  };
}

/** The service for this process's UPDATER_URL and APP_VERSION. */
export function getUpdatesService(): UpdatesService {
  const url = getUpdaterConfig().UPDATER_URL;
  return createUpdatesService({
    client: url ? createUpdaterClient({ url }) : null,
    appVersion: getVersionConfig().APP_VERSION ?? null,
  });
}
