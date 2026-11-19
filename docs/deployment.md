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

Logbook needs PostgreSQL 18. Background jobs (pg-boss) keep their tables in
the `pgboss` schema of the same database.

## Docker Compose

[`compose.yaml`](../compose.yaml) runs `migrate`, `web`, and `worker`
against the PostgreSQL in `DATABASE_URL`, and the optional `updater`
([automatic updates](#automatic-updates)). Run it on [Coolify](#coolify) or
on a [Debian server](#debian) (Debian 12 or later, or a similar system with
systemd and apt, such as Ubuntu 24.04). Both take `compose.yaml` from the
branch `stable`, which is at the newest release; `main` has changes that are
not released yet.

`LOGBOOK_VERSION` is required: Compose stops with a message without it.

Put a reverse proxy that terminates TLS in front of `web` (Coolify's own, or
Caddy on Debian) and use its public URL as `LOGBOOK_BASE_URL`. Use exactly
that URL: login redirects and links in messages are built from it.

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
   If your platform reads Compose from GitHub, point it to `meldgrove/logbook`
   and follow `stable`.
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

## Coolify

1. **Database:** create a PostgreSQL 18 resource and copy its internal URL.
   `compose.postgres.yaml` does not work on Coolify: it passes its one
   Compose file with `-f`, which overrides `COMPOSE_FILE`.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/logbook`, branch `stable`,
   Docker Compose location `/compose.yaml`. Under Advanced, set Auto deploy
   to "Manual deployments only", so that only releases deploy, and turn on
   "Connect To Predefined Network", so that Logbook reaches the database.
   Without it, `migrate` logs `getaddrinfo EAI_AGAIN` and fails after a
   minute.
3. **Domain:** assign the domain, such as `https://logbook.example.org`, to
   `web`, port 3000.
4. **Register Logbook at your provider** with the redirect URI
   `<LOGBOOK_BASE_URL>/api/auth/callback/oidc`
   ([identity and access](identity-and-access.md#openid-connect-login)).
5. **Environment variables** of the resource
   ([configuration](configuration.md)): `LOGBOOK_VERSION` (a series such as
   `0.2`, see [automatic updates](#automatic-updates)), `LOGBOOK_BASE_URL`
   (the domain), `DATABASE_URL` (the database's internal URL), a new
   `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), the `OIDC_*` variables,
   and `DIRECTORY` with its settings.
6. **Deploy**, open `LOGBOOK_BASE_URL`, sign in, and set up people and teams
   ([manual directory](identity-and-access.md#manual-directory) or
   [Keycloak directory](identity-and-access.md#keycloak-directory)).
7. **Automatic updates:** set them up [on Coolify](#on-coolify).

## Debian

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
   (`openssl rand -base64 32`), the `OIDC_*` variables, and `DIRECTORY` with
   its settings. Remove `NOTIFICATION_TRANSPORT` (production sends for real).

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
   (`apt install caddy`), and replace `/etc/caddy/Caddyfile` with:

   ```text
   logbook.example.org {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself.

7. Open `LOGBOOK_BASE_URL`, sign in, and set up people and teams
   ([manual directory](identity-and-access.md#manual-directory) or
   [Keycloak directory](identity-and-access.md#keycloak-directory)).
8. **Automatic updates:** set them up [on Debian](#on-debian).

## Health checks

| Endpoint | Meaning |
|---|---|
| `GET /-/healthz` | Liveness: the process answers, with the release version (`null` for images built from source). No dependency checks |
| `GET /-/readyz` | Readiness: the database answers and every migration of this build is applied. 503 otherwise |

The worker writes a heartbeat file every 30 seconds;
`node dist/worker-healthcheck.mjs` fails when it is older than 90 seconds. The
admin page shows the worker's last heartbeat.

## Operations

- **Backups**: Logbook never deletes entries, people, or the audit log, so
  the database backup is the safety net. Back up the whole database,
  including the `pgboss` schema.
- **Logs** are JSON lines on stdout. The `service` field names the process.
- **Admin page** (`/admin`): directory sync status, notification channels and
  failures, webhook deliveries, the default periods of the decision
  process, and [updates](#automatic-updates).
- **Upgrades**: read the release notes of every release since yours and
  take their steps. Back up the database first: migrations only move
  forward. `migrate` applies new migrations before `web` and `worker` start.
  - **Coolify:** set `LOGBOOK_VERSION` to the new release in the resource's
    environment variables and redeploy. Coolify reads `compose.yaml` from
    `stable`, which is at the newest release.
  - **Debian:** in `/srv/logbook`, run `git pull` (the newest release's
    `compose.yaml`), then install the release with the
    [update button](#the-update-button), or set `LOGBOOK_VERSION` in `.env`
    and run `docker compose up -d --pull always`.

## Automatic updates

`compose.yaml` includes the `updater` service of
[Meldgrove Updater](https://github.com/meldgrove/updater). Once an hour it
checks for new versions of Logbook and installs them: on a Debian server
through the server, which pulls the image and restarts Logbook, `migrate`
first; on Coolify through its deploy link. Until it is set up
[on Debian](#on-debian) or [on Coolify](#on-coolify), it installs nothing,
but admins still see new versions.

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
fails, the button shows why; on a Debian server, a version that does not
become healthy is replaced by the one before. While automatic updates are
off (neither set up as below), the button still shows new versions, but
cannot install them.

The **Updates** card on the admin page shows the installed version, the
channel, and whether updates install automatically. The button and the card
ask the updater at `UPDATER_URL` ([configuration](configuration.md#updates));
without one, they say that there is no update service.

### On Coolify

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy`
   permission; clear `read`. Coolify shows it only once.
3. In Logbook's resource, select Webhooks and copy Deploy Webhook.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to
   the webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token, then redeploy.

On Coolify, the image tag in `LOGBOOK_VERSION` decides what installs, not
the channel in Logbook: a series such as `0.2` installs the releases of that
series, `latest` every release (also those with upgrade steps: watch the
releases on GitHub with Watch → Custom → Releases, and take their steps right
away), and `preview` every preview and release. When the tag points to a new
image, the updater calls the deploy link, and Coolify pulls the image and
restarts Logbook. The `updater` log names the tag it watches.

### On Debian

As root in `/srv/logbook`, with `UPDATE_DEPLOY_HOOK_URL` empty:

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

Installations set up before the update button get it, and the channels, with
the newest `compose.yaml` and the host setup again:

```sh
cd /srv/logbook
git pull
docker compose up -d
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh && sudo sh updater-setup.sh
```

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
