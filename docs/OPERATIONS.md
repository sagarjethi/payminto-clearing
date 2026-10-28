# Operating a Clearing Node

This is the runbook for running a Payminto Clearing Node with real money on HashKey Chain (133 or 177).
Deploying the contract is in [DEPLOY.md](DEPLOY.md); every node variable is listed in `apps/node/.env.example` and `apps/node/README.md`.

The node never holds funds: settlement moves net amounts wallet to wallet through `ClearingHub`.
What it does hold is the operator key (gas only), the admin token, and the SQLite ledger of accepted calls and their receipts.
Those three are what this document protects.

## 1. Shape of a deployment

```
internet --TLS--> reverse proxy (Caddy) --http--> node 127.0.0.1:8787
                                       \--http--> dashboard 127.0.0.1:3000
```

- The node binds `HOST=127.0.0.1` by default; only the Docker image binds `0.0.0.0`, and `docker-compose.yml` publishes its ports on 127.0.0.1.
- Run exactly one node process per `DB_PATH`. SQLite and the operator nonce are single-writer by design.
- A database is pinned to one chain, hub and token; the node refuses to start against a different one. Use a separate `DB_PATH` (or Docker volume) per network.

## 2. TLS with a reverse proxy

The node speaks plain HTTP; terminate TLS in front of it.
Caddy gets and renews certificates automatically:

```caddyfile
node.example.com {
	# EventSource cannot send headers, so the dashboard passes the admin token as ?token= on /v1/events.
	# Move it into the Authorization header and drop it from the URL before it reaches the node or any log.
	@events path /v1/events
	handle @events {
		request_header Authorization "Bearer {http.request.uri.query.token}"
		uri query -token
		reverse_proxy 127.0.0.1:8787 {
			flush_interval -1
		}
	}
	handle {
		reverse_proxy 127.0.0.1:8787
	}
	log {
		output file /var/log/caddy/node.log
		format filter {
			request>uri query {
				delete token
			}
			request>headers>Authorization delete
		}
	}
}

dashboard.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

Then set, for the node:

- `PUBLIC_URL=https://node.example.com` (advertised to agents in x402 payment requirements).
- `CORS_ORIGINS=https://dashboard.example.com`.
- `TRUST_PROXY_HOPS=1`, so per-IP rate limits see the real client address from `X-Forwarded-For` instead of the proxy. Leave it at 0 when nothing sits in front of the node, or clients could spoof the header.

And build the dashboard with `NEXT_PUBLIC_NODE_URL=https://node.example.com` (in Docker: set it in `.env` before `docker compose build`).

### The SSE `?token=` caveat

`GET /v1/events` accepts the admin token in the `Authorization` header or, because browsers' `EventSource` cannot set headers, as `?token=`.
A token in a URL can leak into proxy access logs, browser history and monitoring tools.
The node itself never logs query strings, but anything in front of it might.
Behind a proxy, do what the Caddy example does: rewrite `?token=` into the header, strip it from the URL, and filter it out of the log format.
With nginx, the same is `proxy_set_header Authorization "Bearer $arg_token";` in a `location = /v1/events` block plus a `log_format` that logs `$uri` instead of `$request_uri`, and `proxy_buffering off;` for streaming.
Rotate the admin token if it ever appeared in a log.

## 3. Keys and secrets

- **Operator key** (`OPERATOR_KEY`): signs receipts and HSP adapter receipts and pays gas for `openMandate` and `settleBatch`. It cannot move user funds. Use a fresh key used for nothing else, and keep only enough HSK for a few days of settlements (alert on `payminto_operator_gas_balance_wei`, below).
- **Admin token** (`ADMIN_TOKEN`): full control of the node's admin API, `/metrics` and the live event stream. Generate it with `openssl rand -hex 32`. On 133 and 177 the node refuses the dev token and anything shorter than 32 characters.
- **Public dev keys**: the node refuses all ten anvil/hardhat default keys as `OPERATOR_KEY` on 133 and 177. Anything sent to their addresses on a real chain is taken by bots within seconds.
- **Deployer key**: needed once, for `forge script`. Keep it in a Foundry keystore, never on the node host.
- Keep secrets in `apps/node/.env` or the compose `.env`, both git-ignored, readable by the service user only (`chmod 600`). Prefer a secret manager or `docker compose` secrets on shared hosts.
- Startup errors name the variable, never its value, and logs never contain keys or tokens. `RPC_URL` credentials are redacted in the startup log.

Rotation:

1. Admin token: change it, restart the node, sign in to the dashboard again. Nothing else depends on it.
2. Operator key: stop the node, wait until `payminto_batches{status="submitted"}` and `cosigning` are 0 (or let the node finish on shutdown, it waits for an in-flight settlement), set the new key, fund it with HSK, start. Receipts issued before the rotation name the old operator in their `node` field; keep a record of it.

## 4. Backups and restore

The node's state is one SQLite file (WAL mode) at `DB_PATH`.
Back it up online, while the node runs:

```bash
pnpm --filter @payminto/node backup                 # DB_PATH from apps/node/.env, output to ./backups
pnpm --filter @payminto/node backup --out /srv/payminto-backups
docker compose exec node node scripts/backup.ts     # Docker: written to /data/backups in the node-data volume
```

The command uses SQLite `VACUUM INTO` to write `clearing-<UTC timestamp>.db`, a consistent, compact snapshot.
It never touches the source, refuses to overwrite an existing file, and verifies the copy before reporting success: non-empty, `PRAGMA integrity_check` ok, and no fewer migrations, calls and ledger journals than the source.
A failed check exits non-zero, so a cron job or systemd timer can alert on it.
Copy backups off the host (for example `restic` or `rclone` to object storage) and keep at least a week of dailies.
Copying the `.db` file with `cp` while the node runs is not a backup: it can miss the WAL and be inconsistent.

Restore:

1. Stop the node.
2. Move the current `DB_PATH` and its `-wal` and `-shm` files aside; do not delete them until the restore is confirmed.
3. Copy the backup to `DB_PATH`.
4. Start the node. It checks the database belongs to the configured chain, hub and token, applies any newer migrations, and recovers interrupted batches.
5. Check `/healthz`, the dashboard Overview and `GET /v1/ledger/trial-balance` (it must balance to zero).

Calls accepted after the backup was taken are lost from the ledger, but anything that was settled is still on chain: the hub's `NetTransfer` events and receipt roots are the source of truth for what moved.

The only destructive tool is `pnpm --filter @payminto/node db:reset`, and it refuses any file that is not marked disposable (`*.test.db`, `*.demo.db`, or the OS temp dir).

## 5. Upgrades and migrations

1. Take a backup (section 4).
2. Pull the new version and read the release notes for config changes (`apps/node/.env.example`).
3. Docker: `docker compose build && docker compose up -d`. Bare metal: `pnpm install --frozen-lockfile`, then restart the service.
4. Watch the startup log: `clearing node listening` reports `migrationsApplied`.

Migrations live in `apps/node/migrations/NNN_name.sql`, run in order inside a transaction at startup, and are forward-only.
There is no down migration: to roll back, stop the node, restore the pre-upgrade backup, and start the previous version.
A node shutting down (SIGTERM) stops accepting requests, closes SSE streams and lets an in-flight settlement finish booking before it exits; give it up to 60 seconds (`docker compose stop -t 75`, systemd `TimeoutStopSec=75`).

`ClearingHub` itself has no upgrade path.
A new contract version is a new deployment with a new address and a new `DB_PATH`; mandates do not migrate between hubs.

## 6. Monitoring

- `GET /healthz` (public, never rate limited): 200 when the RPC answers, 503 otherwise. The Docker images use it as their `HEALTHCHECK`.
- `GET /metrics` (admin bearer token): Prometheus text format.

```yaml
scrape_configs:
  - job_name: payminto-node
    scheme: https
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/payminto-admin-token
    static_configs:
      - targets: [node.example.com]
```

| Metric | Alert when |
|---|---|
| `payminto_rpc_up` | 0 for 2 minutes (and `/healthz` fails) |
| `payminto_operator_gas_balance_wei` | below a few settlements' worth (at 500 gwei, one `settleBatch` is roughly 0.1 to 1 HSK) |
| `payminto_unsettled_calls` | keeps growing while `SETTLE_INTERVAL_SEC` is set |
| `payminto_batches{status="failed"}` | increases |
| `payminto_chain_head_block - payminto_revocations_scanned_block` | above about 10,000 blocks (the revocation scan is behind) |
| `payminto_rate_limited_total` | sustained increase (abuse, or limits too tight for a real provider) |
| `payminto_denials` | sudden jump (attack, or a misconfigured agent) |
| `payminto_db_size_bytes` | unexpected growth |

Also exposed: `payminto_http_requests_total`, `payminto_calls{status}`, `payminto_denial_rows`, `payminto_event_rows`, `payminto_sse_clients`, `payminto_ratelimit_keys`, `process_resident_memory_bytes`, `process_uptime_seconds`.
Logs are JSON lines on stdout; ship them with your usual collector.

## 7. Abuse limits and growth bounds

- Per provider API key on `POST /v1/vouchers`: token bucket `RATE_LIMIT_PROVIDER_RPS` / `RATE_LIMIT_PROVIDER_BURST` (default 200/s, burst 1000).
- Per client IP on every request without the admin token (public reads, co-signing, signed revokes, failed logins): `RATE_LIMIT_IP_RPS` / `RATE_LIMIT_IP_BURST` (default 100/s, burst 1000). Agents read their position before each paid call, so an agent host makes about as many reads as calls.
- Over the limit the node answers `429 RATE_LIMITED` with `Retry-After` in seconds. Set an RPS to 0 to disable that limiter.
- Identical denials (same mandate, payee, provider, rule, request and cumulative) within `DENIAL_DEDUP_SEC` are folded into one row with a `repeats` count, so a replay flood costs one row.
- Every minute the node keeps only the newest `DENIALS_MAX_ROWS` denials and `EVENTS_MAX_ROWS` events. Calls, batches and the ledger are never pruned.
- Request bodies are capped at 512 KiB.

Limits are per node process and in memory; they reset on restart.
For internet-facing nodes, add connection limits at the proxy as well.
