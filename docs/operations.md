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

## Production Compose deployment

Every GitHub Release includes `makerspace-core-VERSION-compose.tar.gz`. This is a standalone deployment bundle: it contains a conventional `compose.yaml` pinned to that exact immutable frontend/backend release and a secret-free `.env.example`. A production host needs Docker Compose and this bundle, not a repository checkout or build toolchain. The release images are public and require no registry login.

Extract the archive into an otherwise empty deployment directory, then prepare the installation-specific configuration once:

```sh
cp .env.example .env
chmod 600 .env
```

Set the two blank values in `.env`: `PUBLIC_BASE_URL` is the exact HTTPS browser origin without a path or trailing slash, and `POSTGRES_PASSWORD` is a long random database password. Prefer URL-safe password characters so the environment file needs no quoting. The optional `MAKERSPACE_IMAGE_PREFIX` override supports an approved public registry mirror while retaining the `-backend` and `-frontend` image-name suffixes.

`APP_ENV=production`, `SESSION_COOKIE_SECURE=true`, the backend listen address, and all internal service addresses are fixed in the Compose file. Do not weaken those settings through a deployment override.

### First deployment

Approve the audit, application-log, and backup retention policies above before creating live data. Start the complete deployment from its bundle directory:

```sh
docker compose up -d
```

Compose pulls missing images and waits for healthy PostgreSQL. The backend container runs `goose up` and starts the API process only after migration succeeds; the frontend starts only after the backend is healthy. The deployment defines and runs exactly three containers: database, backend, and frontend. The API binary itself never applies or reverts migrations.

Inspect startup and automatic migration state with:

```sh
docker compose ps
docker compose logs backend frontend
```

If migration fails, the backend exits before the API starts and the frontend cannot pass its backend-health dependency. The backend restart policy retries startup, leaving the migration error inspectable in `docker compose logs backend`. Correct the database or release issue and run the same startup command again.

Create the first master only after the migrated application is healthy:

```sh
docker compose run --rm --entrypoint /app/admin backend bootstrap-master
```

The same entrypoint override supports deliberate recovery and cleanup operations:

```sh
docker compose run --rm --entrypoint /app/admin backend recover-master
docker compose run --rm --entrypoint /app/admin backend cleanup
```

### TLS reverse proxy and health

The frontend defaults to `127.0.0.1:8080` for a reverse proxy on the Docker host. Configure that proxy to terminate HTTPS and forward the complete site—not a separate API origin—to the frontend port. Preserve the public `Host`, append the client address to `X-Forwarded-For`, and send `X-Forwarded-Proto: https`. Keep port 8080 loopback-only or protected by a firewall; never publish the backend or PostgreSQL ports.

If the reverse proxy itself runs in a container, adapt the example to attach it to the Compose network or deliberately override `FRONTEND_BIND_ADDRESS`. Binding to `0.0.0.0` makes unencrypted HTTP reachable on every host interface unless the host firewall prevents it.

Check the complete request path through nginx after deployment:

```sh
curl --fail http://127.0.0.1:8080/
curl --fail http://127.0.0.1:8080/api/v1/health/live
curl --fail http://127.0.0.1:8080/api/v1/health/ready
```

Use the configured `FRONTEND_PORT` instead of 8080 when overridden. Liveness reports that the API process runs; readiness additionally checks PostgreSQL.

### Upgrade and stop

Back up PostgreSQL and confirm restore readiness before each upgrade. Download the newer release bundle and extract its `compose.yaml` and `.env.example` over the deployment directory; keep the populated `.env`. The new Compose file carries the new immutable image version. Upgrade application containers and the schema with the same command used for initial startup:

```sh
docker compose up -d
```

Stopping the stack preserves the named PostgreSQL volume:

```sh
docker compose down
```

Do not add `--volumes` unless deliberate, irreversible database deletion is intended. The expected load is a handful of concurrent users: run one backend process with its conservative pgx pool. Domains, certificates, ACME, reverse-proxy products, backup infrastructure, and any external OTLP collector remain site-specific responsibilities.

## Failure and rollback

Application rollback is safe only while its binary remains compatible with the migrated schema. Prefer forward fixes for data-bearing migrations. For production, restore `compose.yaml` from the previous immutable release bundle and run `docker compose up -d`; backend startup only applies missing forward migrations and never silently downgrades the schema. Revert a production migration only after reviewing its Down section and confirming that losing new schema/data is acceptable. `make migrate-down` remains the development-stack helper for deliberate manual work from a repository checkout.

Account disablement, password set/reset, and Role changes take effect through database-backed authorization on the next request. If access is lost, use the recovery CLI rather than direct table edits. Never extract or manually alter password hashes or session/reset token digests.
