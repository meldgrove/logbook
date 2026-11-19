"use client";

import { CircleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { ChoiceField } from "@/components/entries/entry-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { createDateFormatter } from "@/lib/format";
import type { DisplayPreferences } from "@/lib/preferences";
import { automaticText, CHANNEL_LABELS, PREVIEW_HELP, stableHelp } from "@/lib/updates/state";
import type { Channel, UpdatesResponse } from "@/lib/updates/types";
import { cn } from "@/lib/utils";
import { requestUpdates, setUpdates, useUpdates } from "./updates-store";

const DEPLOYMENT_GUIDE = "https://github.com/meldgrove/logbook/blob/main/docs/deployment.md#automatic-updates";

/**
 * The Updates card on the admin page: the installed version, the channel,
 * and whether updates install automatically. `initial` is the status when
 * the page was rendered; the update button's later answers replace it.
 */
export function UpdatesSettings({ initial, preferences }: { initial: UpdatesResponse; preferences: DisplayPreferences }) {
  const { response: latest } = useUpdates();
  const formatter = useMemo(() => createDateFormatter(preferences), [preferences]);
  const response = latest ?? initial;
  const status = response.updater;
  const [choice, setChoice] = useState<Channel | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const channel = choice ?? status?.channel ?? "stable";
  const locked = !response.reachable || !status || status.channelLocked !== null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!status || channel === status.channel) return;
    setSaving(true);
    setMessage(null);
    const result = await requestUpdates("channel", { channel });
    setSaving(false);
    if (result.kind === "answer") {
      setUpdates({ response: result.body });
      setChoice(null);
      setMessage(
        result.body.error
          ? { tone: "error", text: result.body.error }
          : { tone: "info", text: `Saved: ${CHANNEL_LABELS[channel]}.` },
      );
    } else {
      setMessage({ tone: "error", text: result.kind === "error" ? result.message : "Logbook could not be reached. Try again." });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {!response.reachable ? (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            <p>
              The update service is not reachable. Automatic updates need the updater service from compose.yaml (
              <a href={DEPLOYMENT_GUIDE} className="underline underline-offset-2" target="_blank" rel="noreferrer">
                deployment guide
              </a>
              ).
            </p>
            {response.error ? <p>{response.error}</p> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Installed version" value={response.app.version ?? "development"} />
        <Fact label="Channel" value={status ? CHANNEL_LABELS[status.channel] : "—"} />
        <Fact label="Last check" value={formatter.dateTime(status?.checkedAt ? new Date(status.checkedAt) : null)} />
        <Fact label="Update service" value={status ? `Meldgrove Updater ${status.updater}` : "Not reachable"} />
      </dl>

      {status ? (
        <p className="text-sm">
          <span className="font-medium">Automatic installs: </span>
          {automaticText(status)}
        </p>
      ) : null}
      {status?.error ? (
        <p className="text-sm text-destructive">The last check failed: {status.error}</p>
      ) : null}

      <form onSubmit={save} className="flex flex-col gap-4">
        <ChoiceField<Channel>
          name="channel"
          legend="Channel"
          required
          disabled={locked || saving}
          value={channel}
          onChange={setChoice}
          choices={[
            { value: "stable", label: "Stable (recommended)", help: stableHelp(status?.channel === "stable" ? status.cooldown : null) },
            { value: "preview", label: "Preview", help: PREVIEW_HELP },
          ]}
          hint="Switching back to Stable keeps this version until a release is newer."
        />
        {status?.channelLocked ? <p className="text-sm text-muted-foreground">{status.channelLocked}</p> : null}
        <p
          role="status"
          className={cn("text-sm", message?.tone === "error" ? "text-destructive" : "text-muted-foreground", !message && "sr-only")}
        >
          {message?.text ?? ""}
        </p>
        <div>
          <Button type="submit" variant="outline" size="sm" disabled={locked || saving || channel === status?.channel}>
            {saving ? "Saving…" : "Save channel"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
