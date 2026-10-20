# Hosting Makerspace Core and its local services

This is the one guide for running Makerspace Core and the services that sit next to it, in development and in production. Deep technical background stays in [operations](operations.md), [printer connector](printer-connector.md), [streaming gateway](streaming-gateway.md) and [development](development.md).

## Overview: four Compose stacks

Everything runs with Docker Compose. There are four stacks, each with a fixed Compose project name, its own directory, its own `.env` (from that directory's `.env.example`) and its own volumes.

| # | Stack (project name) | Runs | Where | Development file | Production file |
|---|---|---|---|---|---|
| 1 | `makerspace-core` | frontend, backend, PostgreSQL | a server or cloud host | `compose.yaml` (repository root) | `compose.production.yaml`, shipped as `compose.yaml` in `makerspace-core-VERSION-compose.tar.gz` |
| 2 | `makerspace-connector` | printer connector | makerspace LAN, next to the printers | `printer-connector/compose.development.yaml` | `printer-connector/compose.yaml`, shipped in `makerspace-printer-connector-VERSION-compose.tar.gz` |
| 3 | `makerspace-streaming` | streaming gateway + go2rtc | makerspace LAN, where the signage displays can reach it | `streaming-gateway/compose.development.yaml` | `streaming-gateway/compose.yaml`, shipped in `makerspace-streaming-VERSION-compose.tar.gz` |
| 4 | `makerspace-local-services` | connector + gateway + go2rtc together | makerspace LAN, on one host | none (use stacks 2 and 3) | `local-services/compose.yaml`, shipped in `makerspace-local-services-VERSION-compose.tar.gz` |

- Stack 1 is the application. It is the only stack that needs a database and a public HTTPS address.
- Stacks 2 and 3 are optional services that run in the makerspace network and talk **outbound** to Core (the connector to the printers, the gateway additionally serves the signage displays on the LAN). Run them separately, or run stack 4 instead, which is stacks 2 and 3 in one Compose project with the same variable names, so one `.env` serves both. Never run stack 4 together with stack 2 or 3 on the same host: they publish the same ports and would enrol twice.
- Every release attaches all four bundles. A bundle is a `compose.yaml` plus a `.env.example` (and, for the gateway, an empty `certs/` directory with a README). A host needs Docker Compose and the bundle, not a repository checkout.

## Development quick start

Requirements: Docker with Compose. Run everything from the repository root.

```sh
cp .env.example .env              # then set POSTGRES_PASSWORD
make migrate-up                   # explicit in development; creates the schema
make dev                          # database, backend, frontend with live source mounts
make bootstrap-master             # in a second terminal: first master account (interactive)
```

| URL | What |
|---|---|
| <http://localhost:5173> | the application (Vite; proxies `/api` to the backend) |
| <http://localhost:8080/api/v1> | the API, for diagnostics |
| `localhost:5432` | PostgreSQL (loopback only) |

`make down` stops the stack and keeps the data. `make help` lists every target; see [development](development.md) for generation, tests and migrations.

### Printer connector in development

```sh
make dev-connector                # builds from source, starts detached
make dev-connector-logs
make dev-connector-down
```

`make dev-connector` creates `printer-connector/.env` when it is missing and starts the stack (Compose project `makerspace-connector`). The first time it stops with instructions, because the connector has to be enrolled:

1. In Core (<http://localhost:5173>) open **Machines > Connectors** and create a connector. Copy the one-time secret.
2. Put it into `printer-connector/.env` as `CONNECTOR_ENROLLMENT_SECRET=<secret>`. It is valid for 15 minutes.
3. Run `make dev-connector` again.

Once enrolled, the identity lives in the data volume; the command no longer needs the secret. The development file reaches Core at `http://host.docker.internal:8080` with `CONNECTOR_ALLOW_HTTP=true`; the production `CORE_URL` in `.env` is ignored (override the target with `DEV_CORE_URL`).

### Streaming gateway in development

```sh
make dev-streaming
make dev-streaming-logs
make dev-streaming-down
```

`make dev-streaming` creates `streaming-gateway/.env`, generates a certificate for `localhost` into `streaming-gateway/certs/` (with [mkcert](https://github.com/FiloSottile/mkcert) when installed, otherwise self-signed with openssl), builds the gateway from source and starts it with go2rtc (Compose project `makerspace-streaming`). Before the first enrollment it stops with instructions:

1. In Core open **Settings > Local services**, **Add gateway** with the public host `localhost:8443`, and copy the enrollment secret.
2. Put it into `streaming-gateway/.env` as `STREAM_ENROLLMENT_SECRET=<secret>`.
3. Run `make dev-streaming` again.

With a self-signed certificate (no mkcert) the browser must trust it once: open <https://localhost:8443/> and continue past the warning (the page itself answers 404). With mkcert (`brew install mkcert && mkcert -install`), delete `streaming-gateway/certs/` and run the target again for a browser-trusted certificate.

Development ports are published on `127.0.0.1` only: `8443` (HTTPS, tickets only) and `8555` (WebRTC media). The player origin is `http://localhost:5173` (override with `DEV_STREAM_ALLOWED_ORIGIN` if you run the frontend on another port) and the WebRTC candidate is `127.0.0.1:8555`. A real picture needs a reachable Bambu printer with an active assignment; see [streaming gateway](streaming-gateway.md#development).

## Production

General rules for all four stacks:

- Download the matching bundle from the [GitHub Release](https://github.com/Basmatireis/Makerspace-Core/releases), extract it into its own empty directory, then `cp .env.example .env && chmod 600 .env` and fill in the values below.
- Start and upgrade with `docker compose up -d` from that directory. The images are public; no registry login is needed.
- Images are pinned to a release (never `latest`). Optional digest variables (`PRINTER_CONNECTOR_DIGEST`, `STREAMING_GATEWAY_DIGEST`: `@sha256:...`, read with `docker buildx imagetools inspect <image>:<version>`) pin the exact content as well. `MAKERSPACE_IMAGE_PREFIX` selects an approved registry mirror.
- Never commit a populated `.env`. It is git-ignored in this repository.

### Stack 1: Makerspace Core (`makerspace-core`)

Bundle: `makerspace-core-VERSION-compose.tar.gz` (`compose.yaml` with the release version baked in, `.env.example`). Core stays behind your own TLS reverse proxy, which forwards the whole site to the frontend on `127.0.0.1:8080`.

| Variable | Meaning |
|---|---|
| `PUBLIC_BASE_URL` | exact browser-visible HTTPS origin, no path or trailing slash (required) |
| `POSTGRES_PASSWORD` | long random database password (required; sensitive) |
| `AUTH_CHALLENGE_HMAC_KEY`, `PIN_PEPPER` | independent base64 secrets of at least 32 bytes, `openssl rand -base64 32` (required; sensitive) |
| `APP_ENCRYPTION_KEYS` | ordered base64 32-byte AES keys; required for OIDC/SMTP secrets, printer access codes and stream tickets (sensitive) |
| `FRONTEND_BIND_ADDRESS`, `FRONTEND_PORT` | where the frontend listens; default `127.0.0.1:8080` |
| `HTTP_TRUSTED_PROXIES` | CIDRs of your reverse proxy; required behind one |
| `SIGNAGE_PAIRING_ALLOWED_CIDRS` | optional: only these networks may pair signage displays |
| `STORAGE_BACKEND`, `S3_*`, `AUDIT_RETENTION`, `MAKERSPACE_TIME_ZONE`, `OPEN_DAYS_*`, `OTEL_*` | optional, see `production.env.example` and [operations](operations.md#production-compose-deployment) |

First start: `docker compose up -d` (migrations run inside the backend container before the API starts), then the first master:

```sh
docker compose run --rm --entrypoint /app/admin backend bootstrap-master
```

Upgrade: back up PostgreSQL, extract the new bundle's `compose.yaml` and `.env.example` over the deployment directory (keep `.env`), `docker compose up -d`. Rollback, retention and the reverse proxy are covered in [operations](operations.md).

### Stack 2: Printer connector (`makerspace-connector`)

Bundle: `makerspace-printer-connector-VERSION-compose.tar.gz`. Runs on a host in the printers' network; needs outbound HTTPS to Core and access to the printers. Publishes no ports.

| Variable | Meaning |
|---|---|
| `MAKERSPACE_VERSION` | release of the connector image (filled in by the bundle; **update it when you upgrade**) |
| `CORE_URL` | public HTTPS URL of Core (required) |
| `CONNECTOR_ENROLLMENT_SECRET` | one-time secret from Core (sensitive, first start only) |
| `PRINTER_CONNECTOR_DIGEST`, `MAKERSPACE_IMAGE_PREFIX` | optional |

Re-enrolling: To connect a daemon to a different or newly created connector or gateway, put the new enrollment secret into `CONNECTOR_ENROLLMENT_SECRET` and restart. If the secret differs from the one used for the stored identity, the daemon enrolls with it and replaces its local identity. If Core rejects the new secret, the daemon keeps running with the old identity and logs an error. An unchanged secret is ignored and can be removed. For the gateway the variable is `STREAM_ENROLLMENT_SECRET`. **Moving to another host or recovering a lost data volume:** in Core open the entry (Machines > Connectors, or Settings > Local services) and choose **New enrollment secret**; this works for active and disabled entries and keeps the id, printer assignments and cameras. The running daemon keeps working until the new secret is used, then it is disconnected (it gets 401 and logs the error). Put the secret into the new host's `.env` and start; afterwards stop and remove the old installation. Revoked entries cannot be re-enrolled. To connect to a different entry, delete the old one or let it be revoked, create a new one and copy its secret.

Enrollment: in Core open **Machines > Connectors**, create a connector, copy the secret (shown once, valid 15 minutes), write it into `.env`, run `docker compose up -d`. The connector generates its own credential, exchanges the secret, and stores its identity encrypted in the data volume. From then on `CONNECTOR_ENROLLMENT_SECRET` is ignored (the log says so once); remove it from `.env` and run `docker compose up -d` again. Without an identity and without a secret the container exits with a message saying what to do. Then assign printers to the connector in Core ([printer connector](printer-connector.md#bambu-lab-h2d-and-x1-carbon-setup)).

### Stack 3: Streaming gateway (`makerspace-streaming`)

Bundle: `makerspace-streaming-VERSION-compose.tar.gz` (`compose.yaml`, `.env.example`, `certs/README`; `certs/` is optional). Runs on a host in the makerspace network that the signage displays can reach; it also needs outbound HTTPS to Core and access to the printers' cameras (TCP 322).

| Variable | Meaning |
|---|---|
| `MAKERSPACE_VERSION` | release of the gateway image (filled in by the bundle; **update it when you upgrade**) |
| `CORE_URL` | public HTTPS URL of Core (required) |
| `STREAM_PUBLIC_HOST` | `hostname[:port]` the displays use; must equal the gateway's public host in Core and match the certificate (required) |
| `STREAM_LAN_ADDRESS` | fixed LAN IPv4 of this Docker host; go2rtc advertises `address:8555` to browsers (required) |
| `STREAM_ENROLLMENT_SECRET` | one-time secret from Core (sensitive, first start only) |
| `ACME_EMAIL`, `CLOUDFLARE_DNS_API_TOKEN` | simplest TLS: the gateway obtains and renews a Let's Encrypt certificate itself (the token is sensitive) |
| `ACME_CA_DIR`, `ACME_DNS_RESOLVERS` | optional: ACME directory URL (default Let's Encrypt production; staging for tests) and resolvers for the DNS checks (default `1.1.1.1:53,1.0.0.1:53`) |
| `STREAM_BIND_ADDRESS`, `STREAM_HTTPS_PORT` | optional: publish on one host address / another HTTPS port |
| `STREAM_ALLOWED_ORIGIN` | optional: browser origin of the player when it differs from `CORE_URL` |
| `STREAMING_GATEWAY_DIGEST`, `MAKERSPACE_IMAGE_PREFIX` | optional |

**DNS, TLS and ports.** The player is served over HTTPS from Core, so the gateway must be HTTPS as well, with a certificate the display browsers trust. There are two ways; certificate files win when both are present.

*Option 1 (simplest): built-in Let's Encrypt with Cloudflare.* Your domain's DNS is at Cloudflare and the gateway is only reachable from the LAN. HTTP-01 and TLS-ALPN validation are impossible for such a host, so the gateway uses DNS-01: it creates a temporary `_acme-challenge` TXT record through the Cloudflare API, Let's Encrypt checks it, and the record is removed. You only need the domain, an e-mail address and a token in `.env`:

1. In Cloudflare open the DNS settings of your zone and add an **A record** `signage-gw` (that makes `signage-gw.<your-domain>`) pointing to the **LAN IP** of the Docker host (for example `192.168.1.20`). Set the proxy status to **DNS only** (grey cloud, not proxied): a proxied record would hide the private address.
2. Create an API token (My Profile, API Tokens, Create Token, Custom token) with the permissions **Zone > Zone > Read** and **Zone > DNS > Edit** and, under Zone Resources, **Include > Specific zone > your zone**. The lookup of the zone id needs Zone Read; do not use the global API key. Copy the token (shown once).
3. In `.env` set:

   ```sh
   STREAM_PUBLIC_HOST=signage-gw.example.org:8443
   ACME_EMAIL=ops@example.org
   CLOUDFLARE_DNS_API_TOKEN=<token>
   ```

   `STREAM_PUBLIC_HOST` must be a DNS name (an IP address is refused). Setting `ACME_EMAIL` accepts the Let's Encrypt subscriber agreement; Let's Encrypt uses the address for expiry notices. Leave `certs/` empty.
4. `docker compose up -d`, then `docker compose logs -f streaming-gateway`. The log first says `tls: waiting for certificate`; after typically one or two minutes (DNS propagation) it says `certificate obtained`. The gateway stores its ACME account and the certificate in its data volume and reuses them after restarts, renews when fewer than 30 days remain (checked every 12 hours) and swaps the new certificate in without a restart. Failures are retried with exponential backoff (10 minutes up to 6 hours). Until the first certificate exists, port 8443 refuses TLS handshakes, but the gateway keeps syncing with Core; Core shows it as degraded with `tls: waiting for certificate`, and the container healthcheck stays healthy.

To test without hitting the production rate limits, first set `ACME_CA_DIR=https://acme-staging-v02.api.letsencrypt.org/directory` and restart. Staging certificates are not trusted by browsers. Account and certificate are stored per CA, so removing the variable afterwards makes the gateway request a real certificate; nothing has to be deleted.

The propagation checks use `ACME_DNS_RESOLVERS` (default Cloudflare's `1.1.1.1` and `1.0.0.1`) instead of the host's resolver, so they work even where the local resolver refuses public names that point to private addresses. The container needs outbound access to the ACME directory, `api.cloudflare.com` (HTTPS) and the resolvers (DNS, UDP/TCP 53 to the Cloudflare name servers). Let's Encrypt limits: 5 failed validations per hostname and hour, 5 identical certificates per week; the stored certificate and the backoff keep the gateway far below that, but do not delete the data volume repeatedly.

*Option 2: your own certificate.* Get a certificate for the name from any CA, or an internal CA installed on the displays, and put the chain and private key into `./certs` next to `compose.yaml`:

```text
certs/fullchain.pem
certs/privkey.pem
```

These are the names certbot and acme.sh produce. The directory is bind-mounted read-only (and optional: without it, or without the files, the gateway falls back to option 1). The gateway runs as uid 10001 and must be able to read both files:

```sh
sudo chown 10001:10001 certs/fullchain.pem certs/privkey.pem
sudo chmod 644 certs/fullchain.pem && sudo chmod 600 certs/privkey.pem
```

A renewed certificate is picked up within about a minute without a restart (replace the files, do not edit them in place; the modification time is what is watched). With certbot, `live/` holds symlinks that do not resolve inside a container, so copy the files with `cp -L` from a renewal deploy hook.

If neither certificate files nor both `ACME_EMAIL` and `CLOUDFLARE_DNS_API_TOKEN` are set, the gateway exits at start with a message listing both options.

**Display DNS.** The displays must resolve the name to the LAN IP. Routers with dnsmasq rebind protection (OpenWrt) drop public names that point to private addresses; see [Signage player: DNS on the kiosk](signage-player.md#dns-on-the-kiosk-names-that-point-to-a-private-address) for fixes that need no access to the router.

Open to the displays: `8443/tcp` (HTTPS) and `8555/tcp` plus `8555/udp` (WebRTC media). go2rtc's API (1984) and RTSP (8554) are never published.

Enrollment: in Core open **Settings > Local services**, **Add gateway** with the public host from `STREAM_PUBLIC_HOST`, copy the secret (shown once, valid 15 minutes) into `.env`, run `docker compose up -d`. As for the connector, the value is ignored afterwards and can be removed. Then assign cameras on the gateway's page. Details, security model and hardware assumptions: [streaming gateway](streaming-gateway.md).

### Stack 4: Local services (`makerspace-local-services`)

Bundle: `makerspace-local-services-VERSION-compose.tar.gz` (`compose.yaml`, `.env.example`, `certs/README`; `certs/` is optional). Production only: the connector, the gateway and go2rtc on one host, with the variables of stacks 2 and 3 combined (`CONNECTOR_ENROLLMENT_SECRET` and `STREAM_ENROLLMENT_SECRET` in one `.env`; both identities are stored in separate volumes). Create the connector and the gateway in Core, put both secrets into `.env`, add `ACME_EMAIL` and `CLOUDFLARE_DNS_API_TOKEN` (the gateway then obtains its Let's Encrypt certificate itself, see stack 3 for the Cloudflare steps) or put your certificate into `certs/`, run `docker compose up -d`. For development use `make dev-connector` and `make dev-streaming`.

### Upgrades

| Stack | How |
|---|---|
| 1 | extract the new bundle's `compose.yaml` and `.env.example` over the directory, `docker compose up -d` |
| 2, 3, 4 | extract the new bundle, set `MAKERSPACE_VERSION` in your `.env` to the new version (the bundle's `.env.example` shows it), `docker compose up -d` |

Release a Core version first, then upgrade the local services: the connector and the gateway speak a versioned protocol with Core. To roll back, use the older bundle and version.

### Backups and what is sensitive

| Data | Stack volume / file | Notes |
|---|---|---|
| PostgreSQL | `makerspace-core_postgres_data` | back up with `pg_dump`; contains personal data |
| Private files | `makerspace-core_file_storage` (or your S3 bucket) | back up together with the database |
| Core secrets | `.env` | `POSTGRES_PASSWORD`, `PIN_PEPPER`, `AUTH_CHALLENGE_HMAC_KEY`, `APP_ENCRYPTION_KEYS`: losing the keys makes OIDC/SMTP secrets and printer access codes unreadable |
| Connector identity and queue | `makerspace-connector_connector_data` | encrypted, sensitive; restore to one host only, never clone |
| Gateway identity | `makerspace-streaming_streaming_gateway_data` | encrypted, sensitive; never clone |
| go2rtc configuration | `makerspace-streaming_go2rtc_config` | contains camera credentials; regenerated by the gateway, no backup needed |
| TLS private key | `streaming-gateway/certs/privkey.pem` | mode 0600 |
| Enrollment secrets | `.env` | one-time and short-lived; remove after the first start. Environment values are visible to anyone who can run `docker inspect` on the host |

Volume example (stop the stack first for a consistent copy):

```sh
docker run --rm -v makerspace-connector_connector_data:/data:ro -v "$PWD":/backup alpine tar -czf /backup/connector-data.tar.gz -C /data .
```

With local services in stack 4 the volume names start with `makerspace-local-services_`.

### Coming from the previous layout

- The connector stack was called `makerspace-printer-connector` (development: `...-dev`); it is `makerspace-connector` now and gets a new, empty data volume. Enroll the connector again: in Core revoke or delete the old connector, create a new one and put its secret into `.env`. The old volume can be removed with `docker volume rm makerspace-printer-connector_connector_data`.
- `local-services` keeps its project name and volumes. Already enrolled installs need no enrollment secret any more; delete `secrets/` after moving the gateway certificate to `certs/fullchain.pem` and `certs/privkey.pem`.
- The daemons still honour `CONNECTOR_ENROLLMENT_SECRET_FILE` and `STREAM_ENROLLMENT_SECRET_FILE` (legacy; used only when the variable is not set), so a custom Compose file that mounts a secret file keeps working. The shipped Compose files no longer mount one.
- Removed Make targets: `dev-printer-connector`, `dev-printer-connector-detached`, `dev-local-services`, `dev-local-services-down`, `dev-local-services-logs`, `build-local-services`, `local-services-up`, `local-services-down`, `local-services-logs`. Use `dev-connector`, `dev-streaming` and their `-logs` and `-down` variants. To run released images use the bundles above.

## Troubleshooting

| Symptom | Check |
|---|---|
| Log says "Core rejects this connector's credential (revoked or deleted)" | the connector or gateway was revoked or deleted in Core. Create a new one (Delete works for active and revoked entries), put its secret into `CONNECTOR_ENROLLMENT_SECRET` (gateway: `STREAM_ENROLLMENT_SECRET`) in `.env` and restart; no volume has to be deleted |
| `make dev-connector` or `make dev-streaming` stops with "not enrolled" | put the one-time secret into that stack's `.env` (see above) and run it again; secrets expire after 15 minutes, create a new one in Core if needed |
| Gateway log repeats "Waiting for DNS record propagation" until the 2-minute timeout | the network's router answers DNS on port 53 itself, so the gateway never sees the new TXT record; set `ACME_DNS_PROPAGATION_WAIT=60s` in `.env` and run `docker compose up -d` (Let's Encrypt still validates the record from the internet) |
| Container exits with "not enrolled and ..._ENROLLMENT_SECRET is not set" | same: the identity is missing from the data volume (new volume after a project rename, or `docker compose down --volumes`); put a fresh secret into `.env` and start again |
| Enrollment fails with 401 or 429 | secret expired, used already or mistyped; Core answers 429 after 20 failed attempts in 15 minutes |
| `docker compose` complains `Set MAKERSPACE_VERSION` / `Set CORE_URL` | the variable is missing in that directory's `.env` |
| Gateway: `no TLS certificate configured` | neither certificate files nor both `ACME_EMAIL` and `CLOUDFLARE_DNS_API_TOKEN` are set |
| Gateway: permission denied for `/certs/...` or "only one of the TLS certificate file and the TLS key file exists" | `certs/fullchain.pem` and `certs/privkey.pem` must both exist and be readable by uid 10001 (or remove them to use ACME) |
| Gateway stays at `tls: waiting for certificate`, log says `certificate request failed` | read the error: wrong or too narrow Cloudflare token (needs Zone Read and DNS Edit on the zone), `STREAM_PUBLIC_HOST` not in a Cloudflare zone, outbound DNS/HTTPS blocked, or Let's Encrypt rate limit; it retries with growing delays |
| Browser: name does not resolve on the display | the router's rebind protection blocks the name; see [Signage player](signage-player.md#dns-on-the-kiosk-names-that-point-to-a-private-address) |
| Browser blocks the stream, certificate error | the displays must trust the certificate and `STREAM_PUBLIC_HOST` must match its name; in development open <https://localhost:8443/> once |
| Video connects but stays black | `STREAM_LAN_ADDRESS` wrong or `8555/udp` and `8555/tcp` blocked between display and host |
| Gateway logs a public host mismatch | `STREAM_PUBLIC_HOST` differs from the gateway's public host in Core |
| Connector in development cannot reach Core | `make dev` must run (backend on port 8080); on Linux Docker needs the `host-gateway` entry already in the development file |
| Port already in use | another stack publishes 8443/8555 (for example stack 4 together with stack 3), or change `STREAM_HTTPS_PORT` |
| Where are the logs? | `make dev-connector-logs`, `make dev-streaming-logs`, `make logs`; in production `docker compose logs -f` in the stack directory |
