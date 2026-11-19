import { statusSchema, type Channel, type UpdaterStatus } from "./types";

/*
 * Calls the Meldgrove Updater's API at UPDATER_URL. It has no
 * authentication and is reachable only inside the Compose network, so only
 * the web process calls it, for admins.
 */

/** How long each call may take: a check asks the registry and GitHub (up to 30 s). */
export const UPDATER_TIMEOUTS: UpdaterTimeouts = { status: 3_000, check: 35_000, install: 10_000, channel: 35_000 };

/** Milliseconds per call. */
export type UpdaterTimeouts = Record<"status" | "check" | "install" | "channel", number>;

export type UpdaterCallResult =
  /** 200 or 202 with a status. */
  | { kind: "ok"; httpStatus: number; status: UpdaterStatus }
  /** An error answer, e.g. 409 when the version is not offered. */
  | { kind: "refused"; httpStatus: number; error: string }
  /** No answer in time, no connection, or not an answer of the updater. */
  | { kind: "unreachable"; error: string };

export interface UpdaterClient {
  status(): Promise<UpdaterCallResult>;
  check(): Promise<UpdaterCallResult>;
  install(version: string): Promise<UpdaterCallResult>;
  channel(channel: Channel): Promise<UpdaterCallResult>;
}

export function createUpdaterClient(options: {
  url: string;
  fetch?: typeof fetch;
  timeouts?: UpdaterTimeouts;
}): UpdaterClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeouts = options.timeouts ?? UPDATER_TIMEOUTS;

  async function call(method: "GET" | "POST", path: string, timeoutMs: number, body?: object): Promise<UpdaterCallResult> {
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${options.url}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      return { kind: "unreachable", error: failureMessage(error, options.url, timeoutMs) };
    }
    const json = parseJson(text);
    if (response.ok) {
      const parsed = statusSchema.safeParse(json);
      if (parsed.success) return { kind: "ok", httpStatus: response.status, status: parsed.data };
      return { kind: "unreachable", error: `${options.url} does not answer like the Meldgrove Updater 0.2 or later.` };
    }
    const message = typeof json === "object" && json !== null && "error" in json ? json.error : undefined;
    return {
      kind: "refused",
      httpStatus: response.status,
      error: typeof message === "string" && message ? message : `The update service answered HTTP ${response.status}.`,
    };
  }

  return {
    status: () => call("GET", "/v1/status", timeouts.status),
    check: () => call("POST", "/v1/check", timeouts.check),
    install: (version) => call("POST", "/v1/install", timeouts.install, { version }),
    channel: (channel) => call("POST", "/v1/channel", timeouts.channel, { channel }),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failureMessage(error: unknown, url: string, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `The update service at ${url} did not answer within ${timeoutMs / 1000} seconds.`;
  }
  // fetch reports "fetch failed"; the cause says why (e.g. getaddrinfo ENOTFOUND updater).
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  const reason = cause ?? (error instanceof Error ? error.message : String(error));
  return `The update service at ${url} cannot be reached: ${reason}.`;
}
