# Zendesk GitLab Sync Server

<!-- TOC -->
- [Quick Commands for Production Maintenance](#quick-commands-for-production-maintenance)
- [Features](#features)
- [How It Works](#how-it-works)
- [Field Mapping](#field-mapping)
- [Configuration](#configuration)
- [File Structure](#file-structure)
- [Running the Server (Production & Development)](#running-the-server-production--development)
  - [Production](#production)
  - [Development](#development)
  - [Testing](#testing)
  - [Health Check](#health-check)
  - [Dry Run](#dry-run)
- [Running with Docker Compose](#running-with-docker-compose)

<!-- /TOC -->

This project is a Bun-based server that keeps Zendesk ticket custom fields in sync with their corresponding GitLab work items. It ensures that Zendesk tickets always reflect the current type and status of the work item they are linked to, so agents do not have to leave Zendesk to check.

Data flows one way, from GitLab to Zendesk. Nothing is ever written back to GitLab.

## Quick Commands for Production Maintenance

To start the production server:

```bash
docker compose up --build -d gitlab-zendesk-prod
```

To stop the production server:

```bash
docker compose down
```

## Features

- **Automatic Polling:**
  - Polls Zendesk every 30 seconds for open tickets that have a GitLab work item linked.
  - Fetches every linked work item from GitLab in a single GraphQL request, regardless of how many tickets or projects are involved.
- **Stateless Comparison:**
  - Holds no cache. Each cycle compares GitLab's values against the values already on the ticket and writes only the tickets that differ.
  - A restart, a missed cycle, or a manual edit in Zendesk corrects itself on the next pass.
- **Internal Notes:**
  - The sync writes only fields. The internal note is added by a Zendesk trigger that fires on updates made by the sync's service account, so the note is authored by System rather than by a person.
- **Dry Run Mode:**
  - `DRY_RUN=true` logs every intended write without sending anything to Zendesk.
- **Error Logging:**
  - Logs sync activity, unparseable field values, and work items that GitLab did not return.

## How It Works

1. **Startup:**
   - Validates that all required environment variables are set, and exits if any are missing.
   - Runs one sync cycle immediately, then every 30 seconds.
   - A guard prevents cycles from overlapping if one runs long.

2. **Polling:**
   - Searches Zendesk for tickets that are not closed and have the "GitLab Work Item" field set.
   - Parses each field value into a work item reference. Full URLs, `/-/issues/` links, and hand-typed `group/project#123` references are all accepted; anything else is logged and skipped.
   - Fetches all referenced work items from GitLab in one GraphQL request, grouped by namespace.

3. **Syncing:**
   - Compares each ticket's current "GitLab Type" and "GitLab Status" values against the work item.
   - Builds an update only for tickets where at least one value differs.
   - Sends the updates in bulk, in batches of 100, together with the internal note.

## Field Mapping

| Zendesk field | GitLab source | Example values |
| --- | --- | --- |
| GitLab Work Item | The link an agent pastes in. Read only, never written. | `https://nuohub/nuodb/server/nuodb/-/work_items/14509` |
| GitLab Type | Work item type | Customer Support Request, Bug, Improvement, Spike |
| GitLab Status | Status widget | Open, Untriaged, In progress, Code review, Done, Duplicate, Won't do, Not a bug, Cannot reproduce |

All three must be text fields in Zendesk. A drop-down would reject any value not already defined as an option.

Merge request and epic links are recognised but skipped, and are logged when encountered.

## Configuration

Set the following environment variables in `.env`. 

- `ZENDESK_DOMAIN` - Zendesk API base URL, no trailing slash
- `ZENDESK_OAUTH_CLIENT_ID` - Zendesk OAuth client identifier
- `ZENDESK_OAUTH_CLIENT_SECRET` - Zendesk OAuth client secret
- `GITLAB_DOMAIN` - GitLab base URL, no trailing slash. Also used to reject work item links pointing at any other host
- `GITLAB_TOKEN` - GitLab personal access token with the `read_api` scope
- `GITLAB_WORK_ITEM_FIELD_ID` - Zendesk custom field ID for the work item link
- `GITLAB_TYPE_FIELD_ID` - Zendesk custom field ID for the work item type
- `GITLAB_STATUS_FIELD_ID` - Zendesk custom field ID for the work item status

Optional:

- `DRY_RUN` - set to `true` to log intended writes without sending them
- `NODE_ENV` - controls the log file prefix

Zendesk access tokens from the `client_credentials` grant expire after 30 minutes, so the server mints its own and caches them in memory, refreshing a minute before expiry and again on any 401. Only the client id and secret are configured; no access token is stored.

Tokens act as the OAuth client's **owner**, and that identity is what the internal note trigger keys on. The trigger fires on `Current user is <owner> AND Update via is Web service (API)`. The "Update via" part matters: without it the trigger would also fire on every ticket that user edits by hand in the browser.

The token is requested with the scopes `tickets:read tickets:write read write`. The broader `read` scope is required, not just `tickets:read`: the sync locates its tickets through the search endpoint, which answers 403 to a `tickets:read` only token.

## File Structure

- `index.ts` - Main server logic and the sync cycle
- `zendesk.ts` - Zendesk API client and helpers
- `gitlab.ts` - GitLab GraphQL client
- `gitlabRef.ts` - Parsing of work item links into references
- `log.ts` - Logging utilities
- `logs/` - Server log files
- `health-check.ts` - Health check script
- `tests/unit/` - Offline test suite, no credentials required
- `docker-compose.yml` - Docker Compose configuration
- `Dockerfile` - Docker build instructions
- `.dockerignore` - Keeps secrets and `node_modules` out of the image
- `.env` - Environment variable file

## Running the Server (Production & Development)

- The `gitlab-zendesk-dev`, `gitlab-zendesk-prod`, `gitlab-zendesk-test`, and `gitlab-zendesk-health` services are defined in `docker-compose.yml`.
- All of them read the same `.env` file.

### Production

To run the production server:

```bash
bun start
```

Or, with Docker Compose:

```bash
# Start the production service in the background
# (add --build to force a rebuild)
docker compose up --build -d gitlab-zendesk-prod
# View logs
docker compose logs -f gitlab-zendesk-prod
```

### Development

To run the development server with hot reload:

```bash
bun dev
```

Or, with Docker Compose:

```bash
docker compose up --build -d gitlab-zendesk-dev
docker compose logs -f gitlab-zendesk-dev
```

The dev service mounts the source files, so edits on the host apply without a rebuild.

### Testing

The tests are offline. They need no credentials, no network, and no running server:

```bash
bun test tests/unit
```

With Docker Compose:

```bash
docker compose run --rm gitlab-zendesk-test
```

### Health Check

Verifies that the environment variables and API credentials are correct and that both APIs are reachable. It performs three checks: a Zendesk ticket read, the Zendesk search query the sync depends on, and a GitLab API call.

Run locally:

```bash
bun run health-check.ts
```

Run with Docker Compose:

```bash
docker compose run --rm gitlab-zendesk-health
```

The search check also reports how many open tickets currently have a work item linked.

### Dry Run

Before the first run against a live Zendesk, set `DRY_RUN=true` in `.env` and start the server normally. It performs a full cycle and logs every ticket it would update, the field values, and the text of any internal note, without sending anything.

This is the fastest way to see how many tickets are affected and whether any field values are stale or unparseable.

## Running with Docker Compose

- Ensure you have Docker and Docker Compose installed.
- Copy `.env.example` to `.env` and fill in the required values.
- Use `docker compose up --build -d <service>` to start a service in detached mode.
- Use `docker compose logs -f <service>` to follow the logs of a service.

