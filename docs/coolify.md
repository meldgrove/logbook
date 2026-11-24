# Coolify

For running Logbook on [Coolify](https://coolify.io) instead of on a Linux
server of its own. Coolify uses [`compose.coolify.yaml`](../compose.coolify.yaml):
the services of `compose.yaml`, without a host port, pulling the images at
every deploy, and with an `updater` that calls Coolify's deploy link. The
image, health checks, operations and the update button are the same as on a
server: see [Deployment](deployment.md). Every variable is described in
[Configuration](configuration.md).

## Setup

1. **Database:** create a PostgreSQL 18 resource and copy its internal URL.
   `compose.postgres.yaml` does not work on Coolify: it passes its one
   Compose file with `-f`, which overrides `COMPOSE_FILE`.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/logbook`, branch `stable`,
   Docker Compose location `/compose.coolify.yaml`. Under Advanced, set Auto
   deploy to "Manual deployments only", so that only releases deploy, and
   turn on "Connect To Predefined Network", so that Logbook reaches the
   database. Without it, `migrate` logs `getaddrinfo EAI_AGAIN` and fails
   after a minute.
3. **Domain:** assign the domain, such as `https://logbook.example.org`, to
   `web`, port 3000.
4. **Register Logbook at your provider** with the redirect URI
   `<LOGBOOK_BASE_URL>/api/auth/callback/oidc`
   ([identity and access](identity-and-access.md#openid-connect-login)).
5. **Environment variables** of the resource
   ([configuration](configuration.md)): `LOGBOOK_VERSION` (a series such as
   `0.2`, see [automatic updates](#automatic-updates)), `LOGBOOK_BASE_URL`
   (the domain), `DATABASE_URL` (the database's internal URL), a new
   `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), an `UPDATER_TOKEN`
   (`openssl rand -hex 32`, recommended: [it protects the update
   service](#protect-the-update-service)), the `OIDC_*` variables, and
   `DIRECTORY` with its settings.
6. **Deploy**, open `LOGBOOK_BASE_URL`, sign in, and set up people and teams
   ([manual directory](identity-and-access.md#manual-directory) or
   [Keycloak directory](identity-and-access.md#keycloak-directory)). Set up
   Slack, email, and the webhook under **Admin › Integrations**, or with
   [`cli settings`](#settings-from-the-command-line).
7. **Automatic updates:** set them up as [below](#automatic-updates).

## Settings from the command line

The operator command sets what **Admin › Integrations** sets, without a
browser ([commands and bodies](deployment.md#settings-from-the-command-line)).
In the resource, open Terminal, choose the `web` container, and run
`cli settings list`. `cli settings apply slack` (or `email`, `webhook`)
waits for the JSON body: paste it, then press Ctrl-D. The terminal
does not show what is pasted, so the secret stays off the screen. Then run
`cli settings test slack` or `cli settings test email --to <address>`.

## Upgrades

Read the release notes of every release since yours and take their steps.
Back up the database first: migrations only move forward. Then set
`LOGBOOK_VERSION` to the new release or series in the resource's environment
variables and redeploy. Coolify reads `compose.coolify.yaml` from `stable`,
which is at the newest release.

## Backups

For [Meldgrove Backups](deployment.md#backups), set `BACKUP_URL` and
`BACKUP_TOKEN` (from the app's source in Backups) in the resource's
environment variables and redeploy. Each deploy pulls the backup agent's
image.

## Automatic updates

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
`UPDATE_COOLDOWN` and `UPDATE_WINDOW` work as on a server
([automatic updates](deployment.md#automatic-updates)). Schedule database
backups first: migrations run without anyone watching.

### Protect the update service

With `UPDATER_TOKEN` set, Logbook sends it with each request to the updater,
and the updater refuses requests without it. Recommended for resources set
up before it existed; without it, everything works as before. Until it is
done, the **Updates** card on the admin page warns that the update service
takes requests without a token (with updater 0.2.4 or later, which reports
it). Do it once the tag in `LOGBOOK_VERSION` gives the release whose notes
name this step, or a newer one: each deploy pulls that tag, and an older
version does not send the token, so its update button would get no answer.
In the resource's environment variables, set `UPDATER_TOKEN` to the output
of `openssl rand -hex 32`, then redeploy: Coolify reads
`compose.coolify.yaml` from `stable` and pulls the images again.

## Moving an existing resource

Resources set up before `compose.coolify.yaml` existed read
`/compose.yaml`. That file is made for a server now: it has no deploy link
and does not pull the images again, so automatic updates stop with it. Once
the release that brings `compose.coolify.yaml` is out (its release notes
name this step):

1. In the resource's configuration, set Docker Compose Location to
   `/compose.coolify.yaml` and save.
2. Keep the environment variables. Change `LOGBOOK_VERSION` when the release
   starts a new series.
3. Redeploy. The services and volumes keep their names, so the data stays.
