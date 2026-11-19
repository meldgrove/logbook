import { z } from "zod";

/*
 * The Meldgrove Updater's API (contract:
 * https://github.com/meldgrove/updater#the-apps-update-button) and the answer
 * of Logbook's own routes under /api/admin/updates. Client components import
 * only the types.
 */

const isoDate = z.string();

/** A version the updater offers. */
export const updateSchema = z.object({
  /** e.g. "0.2.1", "0.2.1-preview.3", or "sha256:<12 hex>" for an image without version. */
  version: z.string(),
  preview: z.boolean(),
  publishedAt: isoDate.nullable(),
  /** Release notes, or the compare view of a preview. */
  url: z.string().nullable(),
  /** Change titles, newest release first, at most 15. */
  notes: z.array(z.string()),
  /** All changes, when more than `notes`. */
  changes: z.number(),
  /** When it installs automatically; null: not automatically. */
  installsAt: isoDate.nullable(),
  /** Why an earlier installation of this version failed. */
  failed: z.string().nullable(),
});

export const statusSchema = z.object({
  updater: z.string(),
  mode: z.enum(["host", "platform", "off"]),
  channel: z.enum(["stable", "preview"]),
  /** Why admins cannot switch the channel; null: they can. */
  channelLocked: z.string().nullable(),
  installed: z.string().nullable(),
  available: updateSchema.nullable(),
  /** A newer series that needs upgrade steps (Stable only). */
  attention: updateSchema.nullable(),
  installing: z
    .object({
      version: z.string(),
      startedAt: isoDate,
      manual: z.boolean(),
      /** "requested", "pulling", "starting", "rolling-back", or "deploying"; kept open for later stages. */
      stage: z.string(),
    })
    .nullable(),
  last: z
    .object({
      version: z.string(),
      result: z.enum(["installed", "failed", "rolled-back", "accepted"]),
      message: z.string().nullable(),
      finishedAt: isoDate,
    })
    .nullable(),
  checking: z.boolean(),
  checkedAt: isoDate.nullable(),
  error: z.string().nullable(),
  automatic: z.boolean(),
  cooldown: z.string().nullable(),
  window: z.string().nullable(),
  timezone: z.string(),
});

export type Update = z.infer<typeof updateSchema>;
export type UpdaterStatus = z.infer<typeof statusSchema>;
export type Channel = UpdaterStatus["channel"];

/** The answer of every route under /api/admin/updates. */
export interface UpdatesResponse {
  /** APP_VERSION; null in development and in images built from source. */
  app: { version: string | null };
  /** False: no updater answers at UPDATER_URL. */
  reachable: boolean;
  updater: UpdaterStatus | null;
  /** Why the updater refused or could not be reached. */
  error: string | null;
}

/** A version admins may ask to install: a release, a preview, or an image digest. */
export const installableVersion = z
  .string()
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(-preview\.[0-9]+)?$|^sha256:[0-9a-f]{12}$/, "is not a version");

export const installRequestSchema = z.object({ version: installableVersion });
export const channelRequestSchema = z.object({ channel: z.enum(["stable", "preview"]) });

/** How a browser request to a route under /api/admin/updates ended. */
export type UpdatesRequestResult =
  | { kind: "answer"; httpStatus: number; body: UpdatesResponse }
  /** No answer, or 5xx: Logbook restarts (or the network is down). */
  | { kind: "outage" }
  /** 401, 403, 404, or a redirect: the admin session ended (or a POST came from elsewhere). */
  | { kind: "signed-out"; message: string }
  /** Another answer without a status, such as 400. */
  | { kind: "error"; message: string };
