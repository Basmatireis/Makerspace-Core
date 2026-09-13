# Operations

## First master bootstrap

Apply migrations before bootstrap. There is no default credential, public registration, or HTTP bootstrap endpoint.

```sh
make migrate-up
docker compose --profile tools run --rm --build admin bootstrap-master
```

The CLI requires an interactive TTY and prompts for first name, last name, separate contact and login email addresses, and a non-echoed password. It does not accept passwords through flags, standard input, or environment variables. It creates the Person, Account, email/password identity, credential, master assignment, and secret-free audit event in one transaction.

Bootstrap locks the relevant database state and refuses to create a second “first” master if a master assignment already exists. A failed command leaves no partial Person or credential.

## Master recovery

Recovery is a local, deliberate administrative CLI workflow for an installation with no enabled master Account. It is never remotely exposed:

```sh
docker compose --profile tools run --rm --build admin recover-master
```

The command prompts for the existing target account's login email and a twice-entered, non-echoed password on its TTY. It runs only when no enabled master remains, enables the selected Account, provisions its password, assigns master, revokes stale sessions/reset tokens, and records an `admin_cli` audit event without secrets. Run it only with database-level administrative authority and record the operational reason outside the application if organizational policy requires it.

## Cleanup and retention

Expired/revoked sessions and expired password-reset tokens are operational data, not permanent records. Run cleanup manually or from the deployment's existing scheduler:

```sh
docker compose --profile tools run --rm --build admin cleanup
```

Audit retention must be based on a documented organizational/legal purpose. The initial default is `AUDIT_RETENTION=8760h` (365 days), and cleanup removes older events without retaining full before/after PII snapshots. Confirm this period against local policy before production use. A one-off explicit non-secret RFC 3339 cutoff can override the calculated cutoff:

```sh
docker compose --profile tools run --rm --build admin cleanup --audit-before 2026-01-01T00:00:00Z
```

Cleanup always prunes expired sessions/reset tokens and, by default, audit rows older than the configured retention. `AUDIT_RETENTION=0` is the deliberate opt-out for installations whose confirmed policy requires externally managed retention; it must not arise from a missing configuration value. Test the policy on a backup before the first production audit purge.

Person and Account deletion remains a separate authorized product operation. Hard deletion cascades credentials and sessions rather than retaining PII under a soft-delete flag. Audit actor references become null and resource UUIDs remain non-PII context.

Application-log and backup retention are separate deployment policies; neither inherits the 365-day audit default. Before production, the operator must record and approve all three periods:

- **Audit events:** confirm or replace the application default above.
- **Application logs:** configure the deployment platform's rotation and deletion period to the shortest duration needed for diagnosis. Logs are disposable, must keep the documented PII/secret exclusions, and must not be treated as an audit archive.
- **Database backups:** define encrypted backup frequency, retention, access control, restore testing, and final expiry. Backups can temporarily retain records that were hard-deleted from the live database, so the policy must also describe how deletion and legal-retention obligations apply to backup generations.

No production deployment is ready until these values and owners are explicit in that deployment's operating record. Repository defaults cannot decide the makerspace's legal or organizational obligations.

## Deployment expectations

This repository supplies application images and a development Compose topology, not production ingress. A production environment provides PostgreSQL 18, TLS termination, durable storage, secret injection, backups, and any external OTLP collector.

Before serving traffic:

1. Approve the audit, application-log, and backup retention policies above; back up PostgreSQL and verify restoration procedures.
2. Run goose migrations as an explicit release step and verify status.
3. Set `APP_ENV=production` and `SESSION_COOKIE_SECURE=true`; startup must reject an insecure production cookie configuration.
4. Set `PUBLIC_BASE_URL` to the exact HTTPS browser origin without a path.
5. Supply `DATABASE_URL` from the deployment's secret facility, with TLS settings appropriate to the database network.
6. Keep the API and frontend same-origin at `/api/v1` and `/`; do not expose PostgreSQL publicly.
7. Check `/api/v1/health/live` for process liveness and `/api/v1/health/ready` for dependency readiness.

The expected load is a handful of concurrent users. Run one backend process with a conservative pgx pool; do not add Redis, queues, replicas, or distributed session infrastructure. Production edge/TLS, domains, ACME, Cloudflare, Pangolin, Kubernetes, and other site-specific infrastructure remain outside this repository.

## Failure and rollback

Application rollback is safe only while its binary remains compatible with the migrated schema. Prefer forward fixes for data-bearing migrations. Use `make migrate-down` only after reviewing the migration's Down section and confirming that losing new schema/data is acceptable.

Account disablement, password set/reset, and Role changes take effect through database-backed authorization on the next request. If access is lost, use the recovery CLI rather than direct table edits. Never extract or manually alter password hashes or session/reset token digests.
