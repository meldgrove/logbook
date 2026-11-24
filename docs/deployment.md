# Deployment

Logbook ships as one Docker image, `ghcr.io/meldgrove/logbook`, for
linux/amd64 and linux/arm64. Each [release](https://github.com/meldgrove/logbook/releases)
is tagged with its version (e.g. `0.2.0`) and its series (`0.2`, which moves to
every later release of the series; from 1.0.0 the series is the major
version, `1`); `latest` is the newest release. A release that needs manual
steps starts a new series, so the releases within a series install without
anyone acting. Release candidates (`0.2.0-rc.1`) are for testing and get only
their own tag. Previews (`0.2.1-preview.3`, and `preview` for the newest)
are built from every change on `main` once its checks pass. Run a fixed
version and upgrade on purpose, or let the updater install new versions
([automatic updates](#automatic-updates)). The image's command selects the
process:

| Command | What it does |
|---|---|
| `migrate` | Applies the SQL migrations in `drizzle/`, then exits. Run it before `web` and `worker` start, on every deployment |
| `web` | The Next.js server on port 3000 |
| `worker` | Background jobs: notifications, reminders, the webhook, and the Keycloak directory sync. One is enough; more can run, since jobs are coordinated through the database |
| `directory-sync` | Runs one Keycloak directory sync, then exits |
| `cli` | The operator command: sets Slack, email, and the webhook without a browser ([settings from the command line](#settings-from-the-command-line)) |

Logbook needs PostgreSQL 18. Background jobs (pg-boss) keep their tables in
the `pgboss` schema of the same database.

## Docker Compose

[`compose.yaml`](../compose.yaml) runs `migrate`, `web`, and `worker`
against the PostgreSQL in `DATABASE_URL`, and the optional `updater`
([automatic updates](#automatic-updates)). It is made for a Linux server:
Debian 12 or later, or a similar system with systemd and apt, such as Ubuntu
24.04 ([setup](#setup)). The server takes `compose.yaml` from the branch
`stable`, which is at the newest release; `main` has changes that are not
released yet. To run Logbook on Coolify instead, see [Coolify](coolify.md).

`LOGBOOK_VERSION` is required: Compose stops with a message without it.

`web` listens on `127.0.0.1:3000`, on the server only; `LOGBOOK_PORT`
changes the host port. Put a reverse proxy that terminates TLS in front of it
(Caddy, see [setup](#setup)) and use its public URL as `LOGBOOK_BASE_URL`.
Use exactly that URL: login redirects and links in messages are built from
it. With several apps on one server, give each its own port and its own site
in the Caddyfile.

Set `TZ` to your organization's time zone (default UTC): deadlines end at
23:59, and reminders go out at 09:00, in that zone.

### Upgrading from Logbuch

The first Logbook release uses the new image path. The updater on the old
image path will not discover it.

1. Back up PostgreSQL. Keep the same `DATABASE_URL`, `BETTER_AUTH_SECRET`,
   public URL, and OIDC settings. Keep the existing Compose project name and
   volumes. If you run the bundled PostgreSQL, set `POSTGRES_USER=logbuch`
   and `POSTGRES_DB=logbuch` to match the existing volume.
2. Take the Compose files from the new release and set `LOGBOOK_VERSION` to
   its version or series. Rename `LOGBUCH_BASE_URL` to `LOGBOOK_BASE_URL`.
   On Coolify, point the resource to `meldgrove/logbook`, branch `stable`,
   Docker Compose location `/compose.coolify.yaml` ([Coolify](coolify.md)).
3. Deploy the new version. The session cookie has a new name, so people will
   sign in again. If you pinned `MAIL_FROM_NAME` to the old name, set it to
   `Logbook` or remove the override to use the new default.

Existing release images remain at `ghcr.io/meldgrove/logbuch`. To continue
using one, use the Compose files from its tag.

### Checking the image

Every release image carries a provenance attestation, signed by GitHub, that
names the commit and the workflow run it was built from. With the
[GitHub CLI](https://cli.github.com):

```sh
gh attestation verify oci://ghcr.io/meldgrove/logbook:0.2.0 \
  --repo meldgrove/logbook --signer-repo meldgrove/.github
```

### Building the image yourself

To run your own build, for example of a change that is not released yet, build
the image from a clone of the repository and give it a version of its own:

```sh
docker build -t ghcr.io/meldgrove/logbook:local .
# In .env: LOGBOOK_VERSION=local
docker compose up -d
```

## Setup

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files** at the newest release:

   ```sh
   git clone --branch stable https://github.com/meldgrove/logbook.git /srv/logbook
   cd /srv/logbook
   ```

3. **Register Logbook at your provider** with the redirect URI
   `<LOGBOOK_BASE_URL>/api/auth/callback/oidc`
   ([identity and access](identity-and-access.md#openid-connect-login)).
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set the production values
   ([configuration](configuration.md)): `LOGBOOK_VERSION` (the newest
   release, such as `0.2.0`; the updater keeps it current), `LOGBOOK_BASE_URL`,
   `DATABASE_URL`, a new `BETTER_AUTH_SECRET`
   (`openssl rand -base64 32`), an `UPDATER_TOKEN` (`openssl rand -hex 32`,
   recommended: [it protects the update service](#protect-the-update-service)),
   the `OIDC_*` variables, and `DIRECTORY` with its settings. Remove
   `NOTIFICATION_TRANSPORT` (production sends for real). Slack, email, and the
   webhook are not set here: see step 7.

   Without a PostgreSQL of your own, set these values for the database.
   `COMPOSE_FILE` makes every `docker compose` command also use
   [`compose.postgres.yaml`](../compose.postgres.yaml), which runs PostgreSQL
   18 next to Logbook and keeps its data in the volume `postgres-data`:

   ```sh
   COMPOSE_FILE=compose.yaml:compose.postgres.yaml
   # openssl rand -hex 32: no characters that would need escaping in the URL
   POSTGRES_PASSWORD=<password>
   DATABASE_URL=postgres://logbook:<password>@postgres:5432/logbook
   ```

   PostgreSQL uses `POSTGRES_USER`, `POSTGRES_DB` (both default to
   `logbook`), and `POSTGRES_PASSWORD` when it initializes the volume. For an
   existing volume, set them to the role, database, and password already in
   use.

5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   logbook.example.org {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself.

7. Open `LOGBOOK_BASE_URL`, sign in, and set up people and teams
   ([manual directory](identity-and-access.md#manual-directory) or
   [Keycloak directory](identity-and-access.md#keycloak-directory)). Set up
   Slack, email, and the webhook under **Admin › Integrations**, or on the
   server with [`cli settings`](#settings-from-the-command-line).
8. **Automatic updates:** [set them up](#setup-on-the-server).

## Health checks

| Endpoint | Meaning |
|---|---|
| `GET /-/healthz` | Liveness: the process answers, with the release version (`null` for images built from source). No dependency checks |
| `GET /-/readyz` | Readiness: the database answers and every migration of this build is applied. 503 otherwise |

The worker writes a heartbeat file every 30 seconds;
`node dist/worker-healthcheck.mjs` fails when it is older than 90 seconds. The
admin page shows the worker's last heartbeat.

## Operations

- **Backups**: see [Backups](#backups).
- **Logs** are JSON lines on stdout. The `service` field names the process.
- **Admin page** (`/admin`): directory sync status, notification channels and
  failures, webhook deliveries, the default periods of the decision
  process, and [updates](#automatic-updates). **Admin › Integrations**
  (`/admin/integrations`) sets up Slack, email, and the webhook; the worker
  picks up a change within seconds, without a restart.
- **Upgrades**: read the release notes of every release since yours and
  take their steps. Back up the database first: migrations only move
  forward. `migrate` applies new migrations before `web` and `worker` start.
  In `/srv/logbook`, run `git pull` (the newest release's `compose.yaml`),
  then install the release with the [update button](#the-update-button), or
  set `LOGBOOK_VERSION` in `.env` and run
  `docker compose up -d --pull always`.

## Settings from the command line

Everything under **Admin › Integrations** can also be set on the server,
without a browser, with the operator command `cli`. It runs the page's own
code: the same checks, the same encryption, and the same audit log, which
names the actor `operator` and the command. It starts no server, and exits.

```sh
cd /srv/logbook
docker compose run --rm -T migrate cli settings list
```

In a running container, such as a terminal on Coolify, the command is just
`cli …` (`docker compose exec web cli settings list`).

| Command | What it does |
|---|---|
| `cli settings list [--json]` | Each setting: `set`, `not set`, or `incomplete`, with hints such as `token …a1b2`. Never a secret |
| `cli settings show <name>` | The setting as JSON, as the page shows it: secrets only as hints |
| `cli settings apply <name>` | Saves the JSON body on stdin, as the page's **Save** does; prints what `show` prints |
| `cli settings test slack` | Checks the bot token with Slack and posts a test message to the channel |
| `cli settings test email --to <address>` | Sends a test email to the address |
| `cli help` | The commands and the setting names |

- Settings: `slack`, `email`, and `webhook`.
- Secrets go only in the body on stdin, never in an argument (arguments show
  in `ps` and the shell history). Nothing prints a saved secret. A body
  pasted into a terminal is not shown: paste it, then press Ctrl-D.
- `apply` replaces the whole setting, as the page does: start from what
  `show` prints, which `apply` takes back. As on the page, a missing or
  empty secret keeps the saved one; `null` removes it. An `email` body
  without `smtp` keeps the saved SMTP settings.
- Exit codes: `0` done; `1` refused, with the page's message and the field
  on stderr; `2` a wrong command or a body that is not JSON.
- Logbook has no lists of settings and issues no tokens, so there is no
  `cli settings remove` and no `cli tokens`.
- The command needs `BETTER_AUTH_SECRET` to store a secret. The
  `compose.yaml` of this release passes it to every service.

The bodies, as the Integrations page sends them:

`slack`: the bot token (`xoxb-…`) of a Slack app with the scopes
`chat:write`, `users:read`, and `users:read.email`, and the ID of the channel
for one post per new entry (optional; invite the app to it).

```json
{ "botToken": "<bot token>", "channelId": "C0123456789" }
```

`email` over SMTP (`security`: `tls` on port 465, `starttls` on 587,
`auto` for STARTTLS only when the server offers it, or `none`). Leave out
`username` and `password` for a server without login. A changed `host`, or
weaker `security`, needs the password again. `fromName` defaults to
`Logbook`. `{"provider": "none"}` turns email off.

```json
{
  "provider": "smtp",
  "fromAddress": "logbook@example.org",
  "fromName": "Logbook",
  "smtp": {
    "host": "mail.example.org",
    "port": 587,
    "security": "starttls",
    "username": "logbook@example.org",
    "password": "<password>"
  }
}
```

`email` over MailerSend (an API token with email sending access):

```json
{
  "provider": "mailersend",
  "fromAddress": "logbook@example.org",
  "fromName": "Logbook",
  "mailersend": { "token": "<API token>" }
}
```

`webhook`: the URL that receives published entries, and the secret that
signs each request ([webhook](webhooks.md)), at least 16 characters, such as
the one Meldgrove Connector shows. `{"url": null}` turns the webhook off.
The webhook has no test.

```json
{ "url": "https://hooks.example.org/logbook", "secret": "<signing secret>" }
```

AI with access to the server sets a key this way: it receives the secret as
a file, pipes the body into `cli settings apply`, runs `cli settings test`,
and deletes the file. With `jq`, the secret never appears in an argument:

```sh
jq -n --rawfile token slack-token '{botToken: ($token | rtrimstr("\n")), channelId: "C0123456789"}' \
  | docker compose run --rm -T migrate cli settings apply slack
docker compose run --rm -T migrate cli settings test slack
rm slack-token
```

### Moved from `.env`

Versions before Admin › Integrations read Slack, email, and the webhook from
`.env`: `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `SMTP_URL`,
`MAILERSEND_API_TOKEN`, `MAIL_FROM`, `MAIL_FROM_NAME`, `WEBHOOK_URL`, and
`WEBHOOK_SECRET`. Servers keep working without a step:

- On start, the worker (and any other process that sees them) copies each
  of these variables into the database once, into a field that is still
  empty, with the page's checks. The audit log names the actor
  `environment`. From then on the database wins and the variables are
  ignored, also after an admin clears a field. An `smtp://` URL becomes
  `auto` (STARTTLS when the server offers it, as before) on port 587 unless
  it names another, `smtps://` becomes `tls` on 465.
- Admin › Integrations, `cli settings list`, and one warning in the log at
  start name each of them that is still set. Delete them from `.env` once
  you no longer plan to go back to an earlier version, which reads them.
- The worker needs `BETTER_AUTH_SECRET` to store and read the secrets. The
  `compose.yaml` of earlier versions passes it to `web` only: with that
  file, the worker keeps sending with the variables, as before, cannot
  read what is saved on the page, and Admin › Integrations says so. Take the `compose.yaml` of this release
  (`git pull`) and run `docker compose up -d`; the worker then copies them.

## Backups

### With Meldgrove Backups

The `backup-agent` service in `compose.yaml` sends the database to
[Meldgrove Backups](https://github.com/meldgrove/backups) when Backups asks.
While `BACKUP_URL` is empty, it idles.

1. In Backups, add a source of the kind **Meldgrove app**, and put the two
   lines it shows (`BACKUP_URL`, `BACKUP_TOKEN`) into `.env`.
2. Run `docker compose up -d`, then check the agent:
   `docker compose exec backup-agent backup-agent check`.
3. Let the backup end before the update window (`UPDATE_WINDOW`): automatic
   updates run migrations without anyone present.

Keep `BETTER_AUTH_SECRET` apart from the backups: a restore needs it, the
backups do not hold it, and Backups shows the name on the source page.
Stored sign-in tokens and the secrets of Admin › Integrations (Slack's bot
token, the SMTP password or MailerSend's token, the webhook's signing secret)
are encrypted with it. Without it, people sign in again, and an admin enters
those secrets again.

With [automatic updates](#automatic-updates), run the updater's host setup
again once the app's folder has updater 0.2.2 or later (`git pull`): its
deploy script then pulls the agent's image with each update. Without it:
`docker compose pull backup-agent && docker compose up -d`.

To restore, follow the
[agent's guide](https://github.com/meldgrove/backup-agent#restore).

### By hand

Logbook never deletes entries, people, or the audit log, so the database
backup is the safety net. Back up the whole database, including the `pgboss`
schema.

## Automatic updates

`compose.yaml` includes the `updater` service of
[Meldgrove Updater](https://github.com/meldgrove/updater). Once an hour it
checks for new versions of Logbook and installs them through the server,
which pulls the image and restarts Logbook, `migrate` first. Until the
[host setup](#setup-on-the-server) runs, it installs nothing, but admins
still see new versions.

Admins choose the channel on the admin page, under **Updates**:

- **Stable** (default): releases. A release of the installed series (such as
  `0.2`; from 1.0.0 the major version, such as `1`) needs no manual steps and
  installs automatically. A release that needs upgrade steps starts the next
  series: Logbook shows it, but it never installs on its own. Take its steps,
  then install it with the [update button](#the-update-button).
- **Preview**: every change on `main` as soon as its checks pass, before it
  is released, and every release. Previews install within the hour. New
  features first, and now and then a new bug; previews have no release
  notes. Switching back to Stable installs nothing and never goes back to an
  older version: Logbook keeps the preview until a release is newer.

Schedule database backups first: migrations run without anyone watching.

A release installs three days after it came out, so that a faulty one can be
replaced before it reaches the server. `UPDATE_COOLDOWN` changes the time:
`0` installs within the hour, `7d` waits a week. Security fixes wait as well;
install a release at once with the update button. A deployment stops
Logbook for a moment: `UPDATE_WINDOW`, such as `02:00-05:00` in the time
zone `TZ`, keeps automatic installations out of working hours.

### The update button

Admins see an update button at the top right of every page. A click checks
for updates; a dot means a new version is available. Its popover lists the
changes, links to the release notes, says when the version installs
automatically, and installs it at once with **Install now**. The page
reloads when Logbook is back with the new version. When an installation
fails, the button shows why; a version that does not become healthy is
replaced by the one before. While automatic updates are off (before the
[host setup](#setup-on-the-server)), the button still shows new versions,
but cannot install them.

The **Updates** card on the admin page shows the installed version, the
channel, and whether updates install automatically. The button and the card
ask the updater at `UPDATER_URL` ([configuration](configuration.md#updates-web));
without one, they say that there is no update service. Never publish the
updater's port. With `UPDATER_TOKEN` set, Logbook sends it with each request,
and the updater refuses requests without it; without it, anything that
reaches the updater on the Docker network could install an offered update or
switch the channel.

### Setup on the server

As root in `/srv/logbook`:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The first command starts the version in `LOGBOOK_VERSION`, which the updater
takes as installed. The second writes the setup script from the updater's
image; read it before you run it. The script installs a systemd unit that
waits for the updater's requests. For each, it writes the version into
`LOGBOOK_VERSION` in `.env`, pulls the image, and runs
`docker compose up -d --wait`, `migrate` first. When Logbook does not become
healthy, it restores `.env` and starts the version before.
`journalctl -u meldgrove-updater-logbook.service` shows each installation;
`sh updater-setup.sh remove` switches it off.

The script installs images, not files: when a release changes
`compose.yaml`, its release notes say so, and `git pull` takes the new file.

Installations set up before the update button (with Meldgrove Updater 0.1)
get it, and the channels, with the newest `compose.yaml`, the release that
brings the update button, and the host setup again. First set
`LOGBOOK_VERSION` in `.env` to the release that brings the update button or a
newer one: with the version it pins, `docker compose up -d` would only update
the `updater` and keep Logbook's old image. Then:

```sh
cd /srv/logbook
git pull
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh && sudo sh updater-setup.sh
```

### Protect the update service

Recommended for installations set up before `UPDATER_TOKEN` existed; without
it, everything works as before. Until it is done, the **Updates** card on the
admin page warns that the update service takes requests without a token
(with updater 0.2.4 or later, which reports it). Do it once Logbook runs the
release whose notes name this step, or a newer one: an older version does
not send the token, and its update button would get no answer from the
updater. As root in `/srv/logbook`:

```sh
git pull
# in .env: UPDATER_TOKEN=<the output of: openssl rand -hex 32>
docker compose pull updater
docker compose up -d
```

`git pull` brings the `compose.yaml` that passes the token to Logbook and to
the updater (as `API_TOKEN`); `docker compose pull updater` makes sure the
updater is one that checks it. Then the updater takes only requests that
carry the token.

## Importing old entries from a CSV file

`import-entries` logs updates, learnings, and decisions from before Logbook,
for example from an old decision log or a chat channel. Fill the columns of
[`entry-import-template.csv`](entry-import-template.csv) (comma or semicolon
separated, UTF-8). Unknown columns are ignored.

| Column | Required | Content |
|---|---|---|
| `id` | yes | Unique per row, e.g. the ID in the old log. A row is imported once; running again only adds new rows |
| `type` | no | `update`, `learning`, or `decision` (default) |
| `title` | yes | Up to 120 characters (longer titles are shortened) |
| `date` | yes | When it was published or decided: `YYYY-MM-DD` or `DD.MM.YYYY` |
| `summary` | no | Up to 280 characters; defaults to the first paragraph of the decision text, or of the details |
| `details` | no | Markdown. Shown as **Context** for a decision |
| `rationale` | no | Markdown. For a decision it defaults to "Imported from an earlier decision log." |
| `impact` | no | `small`, `medium`, or `large`; empty shows as "not set" |
| `team` | no | Team name; defaults to `--team` |
| `affected_teams` | no | Names of active teams, separated by commas or semicolons |
| `tags` | no | Names of active tags, separated by commas or semicolons. Create missing tags on the admin page first |
| `related` | no | Ids of rows above in the same file, or of entries imported before |
| `links` | no | Up to 10 http(s) URLs, separated by spaces |

Decisions only:

| Column | Required | Content |
|---|---|---|
| `decider_email` | yes, unless `--fallback-decider` | Email address of a person with access |
| `decision_text` | no | The decision (Markdown); defaults to the title |
| `how_decided` | no | `integrative_process`, `role_decision`, `management_decision`, or `other` (default) |
| `involved_emails` | no | Email addresses, separated by commas, semicolons, or spaces |
| `reversibility` | no | `two_way` or `one_way`; empty counts as two-way when the decision is replaced |
| `why_one_way` | no | Why a one-way decision is hard to reverse |
| `effective_date` | no | `YYYY-MM-DD` or `DD.MM.YYYY` |

Run it in the `worker` container:

1. Copy the file in, or pipe it with `--file -`:
   `docker compose exec -T worker node dist/import-entries.mjs --file - … < entries.csv`.
2. Dry run: nothing is written; every record is printed in full, followed by
   a review fingerprint.

   ```sh
   node dist/import-entries.mjs --file /tmp/entries.csv --team "<team name>" --as <your email>
   ```

   `--as` must be an admin, who becomes the author of the records. If a
   decider has no access, add `--fallback-decider <email>`.
3. Read every record. Entries are visible to everyone with access, so leave
   out rows with personal data (`--skip <id>`, repeatable) or fix the file.
4. Run again with the same file and options and
   `--confirm-no-personal-data <fingerprint>`. It writes only if the file
   still yields exactly the records you reviewed. Imported entries keep their
   original date (noon in the server's time zone), are not posted to Slack,
   and are left out of the statistics.
