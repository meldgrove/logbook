# Configuration

Logbook reads its configuration from environment variables. Blank values count
as unset, except for `UPDATER_URL`. Every process validates what it needs at
startup and stops with a list of missing or invalid variables.

Three processes run from one image (see [deployment](deployment.md)):
`migrate`, `web`, and `worker`. The tables below say which process needs a
variable.

## Required

| Variable | Process | Value |
|---|---|---|
| `DATABASE_URL` | all | `postgres://user:password@host:5432/logbook` |
| `LOGBOOK_BASE_URL` | web, worker | The public URL, e.g. `https://logbook.example.org`. Used for login redirects and links in messages |
| `BETTER_AUTH_SECRET` | web | At least 32 characters: `openssl rand -base64 32`. Signs session cookies |
| `OIDC_ISSUER` | web | Issuer URL of the OpenID Connect provider, e.g. `https://auth.example.org/realms/acme` |
| `OIDC_CLIENT_ID` | web | Client ID registered for Logbook |
| `OIDC_CLIENT_SECRET` | web | Its client secret |

The web and worker still accept `LOGBUCH_BASE_URL` when `LOGBOOK_BASE_URL`
is unset.

## Login

| Variable | Default | Value |
|---|---|---|
| `OIDC_SCOPES` | `openid profile email` | Scopes requested at login, separated by spaces |
| `OIDC_TRUST_EMAIL` | `false` | `true` treats every email address from the provider as verified. Only for providers that do not send `email_verified` (e.g. Microsoft Entra ID) and whose users cannot choose their own address |

See [identity and access](identity-and-access.md) for the redirect URI and
provider-specific notes.

## Directory: who has access

| Variable | Default | Value |
|---|---|---|
| `DIRECTORY` | `manual` | `manual`: admins invite people in Logbook. `keycloak`: people and teams come from Keycloak groups |

With `DIRECTORY=manual`:

| Variable | Default | Value |
|---|---|---|
| `INITIAL_ADMIN_EMAILS` | required | Email addresses, separated by commas. While Logbook has no admin, the first login with one of them (verified by the provider) becomes an admin. Without it, nobody could ever get in; afterwards it has no effect |

With `DIRECTORY=keycloak` (needed by web and worker). All three groups are
required: every entry belongs to a team, and only admins manage tags and
unblock stuck proposals. Write group paths with a leading slash and without a
trailing one.

| Variable | Default | Value |
|---|---|---|
| `KEYCLOAK_ACCESS_GROUP` | required | Group path, e.g. `/logbook`. Its members, and members of its subgroups, have access |
| `KEYCLOAK_ADMIN_GROUP` | required | Group path, e.g. `/logbook-admins`. Its members are admins (and have access) |
| `KEYCLOAK_TEAMS_GROUP` | required | Group path, e.g. `/teams`. Each direct subgroup is a team; it needs at least one |
| `KEYCLOAK_CLIENT_ID` | `OIDC_CLIENT_ID` | Client with a service account that may read users and groups: the role `view-users` and, from Keycloak 26.8.2, the default client scope `kc-admin-api` ([Keycloak setup](identity-and-access.md#keycloak-setup)) |
| `KEYCLOAK_CLIENT_SECRET` | `OIDC_CLIENT_SECRET` | Its secret |

`OIDC_ISSUER` must be the realm URL (`…/realms/<realm>`); the Admin API URL is
derived from it.

## Notifications (worker)

Slack and email are each optional. Events prefer Slack and reminders prefer
email; when one is off, or cannot reach a person (no Slack account, no email
address), the message goes out on the other. So it does after an error that
trying again cannot fix, such as an invalid token, a missing Slack scope, or a
rejected address. Other errors, such as an outage or a rate limit, are retried
after 1, 5, 15, and 60 minutes; the fifth and last attempt tries the other
channel too. Without either channel, Logbook only shows tasks in the app.

| Variable | Default | Value |
|---|---|---|
| `SLACK_BOT_TOKEN` | none | Bot token (`xoxb-…`) of a Slack app with the scopes `chat:write`, `users:read`, and `users:read.email` |
| `SLACK_CHANNEL_ID` | none | Channel ID (`C…`) for one post per new entry. Invite the app to the channel |
| `SMTP_URL` | none | `smtp://user:password@host:587` (STARTTLS) or `smtps://user:password@host:465`. Percent-encode special characters in the password |
| `MAILERSEND_API_TOKEN` | none | MailerSend API token with email sending access. Use either SMTP or MailerSend |
| `MAIL_FROM` | none | Sender address; required with SMTP or MailerSend |
| `MAIL_FROM_NAME` | `Logbook` | Sender name |
| `NOTIFICATION_TRANSPORT` | `live` in production, otherwise `console` | `console` only logs messages instead of sending them |

## Webhook (worker)

| Variable | Default | Value |
|---|---|---|
| `WEBHOOK_URL` | none | HTTPS endpoint that receives published entries. Off without it |
| `WEBHOOK_SECRET` | none | At least 16 characters; required with `WEBHOOK_URL`. Signs every request |

See [webhook](webhooks.md).

## Error reporting (web, worker)

Optional. With `SENTRY_DSN`, server errors in the web process (pages, Server
Actions, route handlers) and failures of the worker go to
[Sentry](https://sentry.io) or a Sentry-compatible service. Only the error and
its stack trace are sent: no user, cookies, headers, request bodies, query
strings, or values from database queries. The browser sends nothing.

The worker rides out a restart of PostgreSQL, such as during an update: it
logs a warning, retries, and carries on once the database answers. A
database that stays unreachable for 5 minutes goes to Sentry, once per
outage.

| Variable | Default | Value |
|---|---|---|
| `SENTRY_DSN` | none | The project's DSN (Client Key). Off without it |
| `SENTRY_ENVIRONMENT` | `production` | Environment name shown in Sentry, e.g. `staging` |
| `SENTRY_RELEASE` | `logbook@<APP_VERSION>` in release images, otherwise none | Release name, e.g. the deployed commit SHA |

## Updates (web)

| Variable | Default | Value |
|---|---|---|
| `UPDATER_URL` | `http://updater:8080` | Address of the `updater` service's API, which the update button and the Updates card on the admin page ask. Under `compose.yaml`, an empty value also means the default; empty switches both off only where Logbook reads its environment directly, without Compose |

The `updater` service itself takes `UPDATE_COOLDOWN` and `UPDATE_WINDOW`
(see [automatic updates](deployment.md#automatic-updates)), and
`UPDATE_REGISTRY_USERNAME` and `UPDATE_REGISTRY_PASSWORD` for an image in a
private registry. On Coolify, it also takes `UPDATE_DEPLOY_HOOK_URL` and
`UPDATE_DEPLOY_HOOK_TOKEN` ([Coolify](coolify.md#automatic-updates)).

## Time zone

Logbook uses the server's time zone, set with the standard `TZ` variable
(e.g. `TZ=Europe/Vienna`; the Docker image defaults to UTC). It decides when a
deadline day ends (23:59), when reminders go out (09:00 on working days,
Monday to Friday), and the months in the statistics. Everyone can choose their
own time zone and date format for display under **Settings**; the default
date format is `DD.MM.YYYY`.

## Operations

| Variable | Default | Value |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOGBOOK_PROCESS` | `web` | Process name in logs. The Docker entrypoint sets it from the command |
| `APP_VERSION` | the version in release images, otherwise none | Set by release images, not by operators. `/-/healthz` and Sentry report it |
| `WORKER_HEARTBEAT_FILE` | `/tmp/logbook-worker-heartbeat` | File the worker touches for its health check |
| `MIGRATIONS_DIR` | `drizzle` | Folder with the SQL migrations |

Docker Compose uses `LOGBOOK_VERSION` to select the image tag. It still
accepts `LOGBUCH_VERSION` when `LOGBOOK_VERSION` is unset. With automatic
updates, the server writes each version it installs into `LOGBOOK_VERSION`.
`LOGBOOK_PORT` (default 3000) is the host port that `compose.yaml` publishes
`web` on, on `127.0.0.1` only.
