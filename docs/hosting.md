# Hosting Makerspace Core and its local service

This is the one guide for running Makerspace Core and the local service that sits next to it, in development and in production. Deep technical background stays in [operations](operations.md), [printer connector](printer-connector.md) (including camera streaming) and [development](development.md).

## Overview: two Compose stacks

Everything runs with Docker Compose. There are two stacks, each with a fixed Compose project name, its own directory, its own `.env` (from that directory's `.env.example`) and its own volumes.

| #   | Stack (project name)   | Runs                                 | Where                                | Development file                             | Production file                                                                                    |
| --- | ---------------------- | ------------------------------------ | ------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `makerspace-core`      | frontend, backend, PostgreSQL        | a server or cloud host               | `compose.yaml` (repository root)             | `compose.production.yaml`, shipped as `compose.yaml` in `makerspace-core-VERSION-compose.tar.gz`   |
| 2   | `makerspace-connector` | printer connector + go2rtc (cameras) | makerspace LAN, next to the printers | `printer-connector/compose.development.yaml` | `printer-connector/compose.yaml`, shipped in `makerspace-printer-connector-VERSION-compose.tar.gz` |

- Stack 1 is the application. It is the only stack that needs a database and a public HTTPS address.
- Stack 2 is the optional **local service**. It runs in the makerspace network and talks **outbound only** to Core: printer status, jobs and, for printers with the camera switch on, camera video. It publishes no port and needs no DNS name, TLS certificate or inbound firewall rule. Signage players never talk to it; they watch cameras through Core.
- Every release attaches both bundles. A bundle is a `compose.yaml` plus a `.env.example`. A host needs Docker Compose and the bundle, not a repository checkout.
- There is no separate streaming-gateway or combined local-services stack any more; the [CHANGELOG](../CHANGELOG.md) describes how to move from one.

## Development quick start

Requirements: Docker with Compose. Run everything from the repository root.

```sh
cp .env.example .env              # then set POSTGRES_PASSWORD
make migrate-up                   # explicit in development; creates the schema
make dev                          # database, backend, frontend with live source mounts
make bootstrap-master             # in a second terminal: first master account (interactive)
```

| URL                            | What                                                  |
| ------------------------------ | ----------------------------------------------------- |
| <http://localhost:5173>        | the application (Vite; proxies `/api` to the backend) |
| <http://localhost:8080/api/v1> | the API, for diagnostics                              |
| `localhost:5432`               | PostgreSQL (loopback only)                            |

`make down` stops the stack and keeps the data. `make help` lists every target; see [development](development.md) for generation, tests and migrations.

### Printer connector in development

```sh
make dev-connector                # builds from source, starts detached (connector + go2rtc)
make dev-connector-logs
make dev-connector-down
```

`make dev-connector` creates `printer-connector/.env` when it is missing and starts the stack (Compose project `makerspace-connector`). The first time it stops with instructions, because the connector has to be enrolled:

1. In Core (<http://localhost:5173>) open **Settings > Local services > Printer connectors** and create a connector. Copy the one-time secret.
2. Put it into `printer-connector/.env` as `CONNECTOR_ENROLLMENT_SECRET=<secret>`. It is valid for 15 minutes.
3. Run `make dev-connector` again.

Once enrolled, the identity lives in the data volume; the command no longer needs the secret. The development file reaches Core at `http://host.docker.internal:8080` with `CONNECTOR_ALLOW_HTTP=true`; the production `CORE_URL` in `.env` is ignored (override the target with `DEV_CORE_URL`). It publishes no ports.

Cameras need nothing more in development: assign a Bambu printer to the connector with **Stream camera** switched on, put a camera widget into a scene, publish it on a display and open <http://localhost:5173/player/> to pair the player. The video travels from the printer through go2rtc and the connector to Core (port 8080), through the Vite proxy to the browser. A real picture needs a reachable Bambu printer; without one the camera widget shows its fallback. Details: [printer connector](printer-connector.md#camera-streaming).

## Production

General rules for both stacks:

- Download the matching bundle from the [GitHub Release](https://github.com/Basmatireis/Makerspace-Core/releases), extract it into its own empty directory, then `cp .env.example .env && chmod 600 .env` and fill in the values below.
- Start and upgrade with `docker compose up -d` from that directory. The images are public; no registry login is needed.
- Images are pinned to a release (never `latest`). Optional digest variables (`PRINTER_CONNECTOR_DIGEST`, `LOCAL_UPDATER_DIGEST`: `@sha256:...`, read with `docker buildx imagetools inspect <image>:<version>`) pin the exact content as well. `MAKERSPACE_IMAGE_PREFIX` selects an approved registry mirror. The go2rtc image is pinned by tag and digest in `compose.yaml` itself.
- Never commit a populated `.env`. It is git-ignored in this repository.

### Stack 1: Makerspace Core (`makerspace-core`)

Bundle: `makerspace-core-VERSION-compose.tar.gz` (`compose.yaml` with the release version baked in, `.env.example`). Core stays behind your own TLS reverse proxy, which forwards the whole site to the frontend on `127.0.0.1:8080`.

| Variable                                                                                      | Meaning                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_BASE_URL`                                                                             | exact browser-visible HTTPS origin, no path or trailing slash (required)                                                                                                                   |
| `POSTGRES_PASSWORD`                                                                           | long random database password (required; sensitive)                                                                                                                                        |
| `AUTH_CHALLENGE_HMAC_KEY`, `PIN_PEPPER`                                                       | independent base64 secrets of at least 32 bytes, `openssl rand -base64 32` (required; sensitive)                                                                                           |
| `APP_ENCRYPTION_KEYS`                                                                         | ordered base64 32-byte AES keys; required for OIDC/SMTP secrets, printer access codes (sensitive)                                                                                          |
| `FRONTEND_BIND_ADDRESS`, `FRONTEND_PORT`                                                      | where the frontend listens; default `127.0.0.1:8080`                                                                                                                                       |
| `FRONTEND_ALLOWED_CLIENTS`                                                                    | optional: only these clients (comma-separated IPs, CIDRs, hostnames) get any response, others get 403; unset: everyone, see [below](#restricting-frontend-clients)                         |
| `HTTP_TRUSTED_PROXIES`                                                                        | forwarding proxies the backend trusts; defaults to the Compose network (`MAKERSPACE_NETWORK_SUBNET`, `172.30.240.0/24`), which covers the bundled nginx and a TLS proxy on the Docker host |
| `MAKERSPACE_NETWORK_SUBNET`                                                                   | subnet of the production Compose network; change only if it collides with a host network                                                                                                   |
| `SIGNAGE_PAIRING_ALLOWED_CIDRS`                                                               | optional: only these networks may pair signage displays                                                                                                                                    |
| `STORAGE_BACKEND`, `S3_*`, `AUDIT_RETENTION`, `MAKERSPACE_TIME_ZONE`, `OPEN_DAYS_*`, `OTEL_*` | optional, see `production.env.example` and [operations](operations.md#production-compose-deployment)                                                                                       |

First start: `docker compose up -d` (migrations run inside the backend container before the API starts), then the first master:

```sh
docker compose run --rm --entrypoint /app/admin backend bootstrap-master
```

Upgrade: back up PostgreSQL, extract the new bundle's `compose.yaml` and `.env.example` over the deployment directory (keep `.env`), `docker compose up -d`. Rollback, retention and the reverse proxy are covered in [operations](operations.md).

#### Restricting frontend clients

`FRONTEND_ALLOWED_CLIENTS` makes the bundled nginx answer only listed clients; everyone else gets `403` (with the usual security headers and `Cache-Control: no-store`) before any page, asset, API request or websocket is served. Entries are separated by commas and may be IPv4 or IPv6 addresses, CIDR ranges or hostnames, for example `FRONTEND_ALLOWED_CLIENTS=192.0.2.10, 10.0.0.0/8, proxy.example.org`. Unset or empty allows every client. Loopback inside the container is always allowed, so the healthcheck keeps working.

- **Hostnames** are resolved once when the frontend container starts, and all their IPv4 and IPv6 addresses are allowed. They are not re-resolved until the container restarts (`docker compose restart frontend`).
- **Invalid entries stop the container**: an entry that is neither an address, a CIDR range nor a resolvable hostname makes the frontend exit at start with a message naming it (`docker compose logs frontend`); it never falls back to allowing everyone. A DNS failure at start has the same effect, and Compose retries.
- **Which address nginx sees**: for traffic from other hosts it is the real source address, because Docker forwards published ports with DNAT. Connections through the Docker host's own loopback (or the userland `docker-proxy`) appear as the Compose network's gateway (by default `172.30.240.1`), so a TLS proxy on the Docker host is allowed by listing that gateway address. A TLS proxy on another host connects with its own address and must be listed itself; the browsers behind it are not checked here (forwarded headers are ignored), so restrict them at that proxy.

This is an application-level filter, not a firewall: the port stays open and connections are accepted before they are refused.

#### Reverse proxy and websockets

Camera video is relayed by Core over websockets, so the TLS reverse proxy in front of the frontend must pass websocket upgrades for two kinds of request: the signage player's viewer socket `/api/v1/signage/player/cameras/{machineId}/stream` and the printer connector's channels `/api/v1/printer-connector/self/stream-control` and `/api/v1/printer-connector/self/stream-sessions/{sessionId}`. The bundled nginx already does (long timeouts, no buffering); the proxy in front of it must not break the upgrade or cut idle connections after a minute. **Caddy** passes websockets by default, so `reverse_proxy 127.0.0.1:8080` is enough. **nginx** needs the upgrade headers and a long read timeout:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; "" close; }

server {
    listen 443 ssl;
    server_name makerspace.example.org;
    # ssl_certificate ...

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Apache needs `mod_proxy_wstunnel`; a CDN or load balancer needs websocket support and an idle timeout of several minutes. Without working websockets everything except live cameras keeps working: the camera widgets show their fallback and the connector cannot serve video.

### Stack 2: Local service (`makerspace-connector`)

Bundle: `makerspace-printer-connector-VERSION-compose.tar.gz`. Runs on a host in the printers' network; needs outbound access to Core and to the printers (status and, for cameras, TCP 322). It runs three containers (plus the optional updater): the printer connector, go2rtc (only when cameras are used, but always started) and a one-shot `go2rtc-config-init`. **It publishes no ports at all**, so it needs no DNS name, certificate or firewall opening. The connector and go2rtc share an internal network without outbound access (go2rtc's API, protected by credentials the connector generates); each has its own outbound network, and go2rtc's reaches only the printers. See [printer connector](printer-connector.md#camera-streaming) for the security model.

| Variable                                                                      | Meaning                                                                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `MAKERSPACE_VERSION`                                                          | release of the connector image (filled in by the bundle; **update it when you upgrade**)     |
| `CORE_URL`                                                                    | public HTTPS URL of Core (required)                                                          |
| `CONNECTOR_ENROLLMENT_SECRET`                                                 | one-time secret from Core (sensitive, first start only)                                      |
| `PRINTER_CONNECTOR_DIGEST`, `LOCAL_UPDATER_DIGEST`, `MAKERSPACE_IMAGE_PREFIX` | optional                                                                                     |
| `COMPOSE_PROFILES=updater`, `DOCKER_SOCKET`                                   | optional: web UI updates, see [Upgrades](#updating-stack-2-from-the-web-ui-optional-updater) |

`CORE_URL` must be https. A plain `http://` URL is refused unless `CONNECTOR_ALLOW_HTTP` is set to `"true"` in `compose.yaml`; do that only when the connection never leaves a trusted network, for example a VPN to the Core host or both running on the same machine. The camera video and the connector's credential then travel unencrypted on that link.

Re-enrolling: To connect a daemon to a different or newly created connector, put the new enrollment secret into `CONNECTOR_ENROLLMENT_SECRET` and restart. If the secret differs from the one used for the stored identity, the daemon enrolls with it and replaces its local identity. If Core rejects the new secret, the daemon keeps running with the old identity and logs an error. An unchanged secret is ignored and can be removed. **Moving to another host or recovering a lost data volume:** in Core open the entry (**Settings > Local services > Printer connectors**) and choose **New enrollment secret**; this works for active and disabled entries and keeps the id, printer assignments and camera switches. The running daemon keeps working until the new secret is used, then it is disconnected (it gets 401 and logs the error). Put the secret into the new host's `.env` and start; afterwards stop and remove the old installation. Revoked entries cannot be re-enrolled. To connect to a different entry, delete the old one or let it be revoked, create a new one and copy its secret.

Enrollment: in Core open **Settings > Local services > Printer connectors**, create a connector, copy the secret (shown once, valid 15 minutes), write it into `.env`, run `docker compose up -d`. The connector generates its own credential, exchanges the secret, and stores its identity encrypted in the data volume. From then on `CONNECTOR_ENROLLMENT_SECRET` is ignored (the log says so once); remove it from `.env` and run `docker compose up -d` again. Without an identity and without a secret the container exits with a message saying what to do. Then assign printers to the connector in Core ([printer connector](printer-connector.md#bambu-lab-h2d-and-x1-carbon-setup)).

Then switch on **Stream camera** for each Bambu printer whose camera should be available to signage displays (the connectors tab or the machine setup wizard). The connector writes go2rtc's configuration, restarts go2rtc and reports the camera as live, idle or unavailable. The camera access code is only in the connector's encrypted store, the 0600 go2rtc configuration volume and Core's encrypted columns.

### Upgrades

| Stack | How                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | extract the new bundle's `compose.yaml` and `.env.example` over the directory, `docker compose up -d`                                             |
| 2     | extract the new bundle, set `MAKERSPACE_VERSION` in your `.env` to the new version (the bundle's `.env.example` shows it), `docker compose up -d` |

Release a Core version first, then upgrade the local service: the connector speaks a versioned protocol with Core. To roll back, use the older bundle and version.

#### Updating stack 2 from the web UI (optional updater)

The local-service bundle contains an optional `updater` service (image `-local-updater`, same release as the others). With it, **Settings > Local services** shows for every connector the running version, Core's version, an **Update available** tag and an **Update** button (`printer_connectors.manage`). Without it the page says that the service has to be updated by hand and shows the commands above.

**Security tradeoff.** The updater mounts the Docker socket. Access to the socket is root access to the host: whoever controls the updater container controls the machine. It is therefore off by default. Enable it only on a host that runs nothing but this bundle, and only if you accept that a compromise of the updater image or the Docker host means full control. The design keeps the exposure small:

- The connector and go2rtc stay read-only, without capabilities, and never see the socket. They hand Core's request to the updater as a small JSON file in the shared `updater_exchange` volume and read its result from there.
- The updater has no network (`network_mode: none`; the Docker engine pulls the images), only the `CHOWN` and `DAC_OVERRIDE` capabilities (to replace `.env` and keep its owner) and `no-new-privileges`.
- It installs only a release version (`MAJOR.MINOR.PATCH`) that is newer than `MAKERSPACE_VERSION` in `.env`; Core itself only offers its own version. Image names and the registry come from `compose.yaml` and `.env`, never from a request. It changes only `MAKERSPACE_VERSION`, comments out digest pins of the previous release (`PRINTER_CONNECTOR_DIGEST`, `LOCAL_UPDATER_DIGEST`; pin the new digests again afterwards if you use pinning), then runs `docker compose pull` and `docker compose up -d --no-build` for the bundle's own services (`UPDATER_SERVICES` in `compose.yaml`). It runs Compose in the bundle directory with the bundle's `compose.yaml`, `compose.override.yaml` (if any) and `.env`, like you would.
- Every request is handled at most once. A failed pull or start restores the previous `.env` (and starts the previous release again) and reports a short reason (`pull_failed`, `up_failed`, `downgrade_refused`, `env_invalid`, `interrupted`, ...) that Core shows; there are no automatic retries. Staff can ask again, which creates a new request.
- The updater does not replace itself while it works; its own image follows with the next manual `docker compose up -d`. Changes to `compose.yaml` in a new release (new variables, services) are not applied by the updater: read the release notes and update by hand when they mention the bundle.

To enable it, add `COMPOSE_PROFILES=updater` to `.env` (for rootless Docker also `DOCKER_SOCKET=/run/user/<uid>/docker.sock`) and run `docker compose up -d`. The connector reports the updater within a minute. To disable it again, remove the line and run `docker compose up -d --remove-orphans`.

The request travels like this: staff click **Update to X.Y.Z** (`POST /printer-connectors/{id}/update`, audited as `printer_connector.update_requested`); Core stores the request (migration 00062) and returns it in the service's configuration; the service writes it into the exchange volume within one poll (10 s); the updater picks it up within 10 s and writes its result, which the service reports in its next heartbeats; Core shows _requested_, _in progress_, _succeeded_ or _failed_. An update still in progress after 15 minutes can be requested again.

### Backups and what is sensitive

| Data                         | Stack volume / file                                | Notes                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                   | `makerspace-core_postgres_data`                    | back up with `pg_dump`; contains personal data                                                                                                                   |
| Private files                | `makerspace-core_file_storage` (or your S3 bucket) | back up together with the database                                                                                                                               |
| Core secrets                 | `.env`                                             | `POSTGRES_PASSWORD`, `PIN_PEPPER`, `AUTH_CHALLENGE_HMAC_KEY`, `APP_ENCRYPTION_KEYS`: losing the keys makes OIDC/SMTP secrets and printer access codes unreadable |
| Connector identity and queue | `makerspace-connector_connector_data`              | encrypted, sensitive; restore to one host only, never clone                                                                                                      |
| go2rtc configuration         | `makerspace-connector_go2rtc_config`               | contains camera credentials; regenerated by the connector, no backup needed                                                                                      |
| Enrollment secrets           | `.env`                                             | one-time and short-lived; remove after the first start. Environment values are visible to anyone who can run `docker inspect` on the host                        |

Volume example (stop the stack first for a consistent copy):

```sh
docker run --rm -v makerspace-connector_connector_data:/data:ro -v "$PWD":/backup alpine tar -czf /backup/connector-data.tar.gz -C /data .
```

### Coming from the previous layout

- The connector stack was called `makerspace-printer-connector` (development: `...-dev`); it is `makerspace-connector` now and gets a new, empty data volume. Enroll the connector again: in Core revoke or delete the old connector, create a new one and put its secret into `.env`. The old volume can be removed with `docker volume rm makerspace-printer-connector_connector_data`.
- The streaming-gateway (`makerspace-streaming`) and combined local-services (`makerspace-local-services`) stacks are gone. Stop and remove them (`docker compose down` in their directory; keep their volumes only as a backup, nothing in them is needed any more), then deploy the connector bundle with its go2rtc service. Cameras of enabled gateway assignments are carried over to the connectors' Bambu assignments automatically; see the [CHANGELOG](../CHANGELOG.md).
- The connector still honours `CONNECTOR_ENROLLMENT_SECRET_FILE` (legacy; used only when the variable is not set), so a custom Compose file that mounts a secret file keeps working. The shipped Compose files no longer mount one.
- Removed Make targets: `dev-printer-connector`, `dev-printer-connector-detached`, `dev-local-services`, `dev-local-services-down`, `dev-local-services-logs`, `build-local-services`, `local-services-up`, `local-services-down`, `local-services-logs`, `dev-streaming`, `dev-streaming-logs`, `dev-streaming-down`, `test-streaming-compose`, `test-local-services-compose`. Use `dev-connector` and its `-logs` and `-down` variants. To run released images use the bundles above.

## Troubleshooting

| Symptom                                                                       | Check                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Log says "Core rejects this connector's credential (revoked or deleted)"      | the connector was revoked or deleted in Core. Create a new one (Delete works for active and revoked entries), put its secret into `CONNECTOR_ENROLLMENT_SECRET` in `.env` and restart; no volume has to be deleted |
| `make dev-connector` stops with "not enrolled"                                | put the one-time secret into `printer-connector/.env` (see above) and run it again; secrets expire after 15 minutes, create a new one in Core if needed                                                            |
| Container exits with "not enrolled and ..._ENROLLMENT_SECRET is not set"      | the identity is missing from the data volume (new volume after a project rename, or `docker compose down --volumes`); put a fresh secret into `.env` and start again                                               |
| Enrollment fails with 401 or 429                                              | secret expired, used already or mistyped; Core answers 429 after 20 failed attempts in 15 minutes                                                                                                                  |
| `docker compose` complains `Set MAKERSPACE_VERSION` / `Set CORE_URL`          | the variable is missing in that directory's `.env`                                                                                                                                                                 |
| Connector refuses to start: Core URL must be https                            | use the public HTTPS URL, or `CONNECTOR_ALLOW_HTTP: "true"` in `compose.yaml` for a VPN or same-host `http://` URL                                                                                                 |
| Connector log: "go2rtc configuration could not be written: permission denied" | the `go2rtc_config` volume is not owned by uid 100 (the `go2rtc-config-init` container sets it; run `docker compose up -d` again)                                                                                  |
| Camera widget shows its fallback; connector says `unavailable`                | the printer must be in LAN mode with the camera on and reachable from the Docker host on TCP 322; check `docker compose logs go2rtc` (error level only) and that the assignment has **Stream camera** on           |
| Camera works from the LAN but never through the public URL                    | the reverse proxy in front of Core does not pass websockets, see [Reverse proxy and websockets](#reverse-proxy-and-websockets); the player closes with a connection error and retries                              |
| Connector in development cannot reach Core                                    | `make dev` must run (backend on port 8080); on Linux Docker needs the `host-gateway` entry already in the development file                                                                                         |
| Where are the logs?                                                           | `make dev-connector-logs`, `make logs`; in production `docker compose logs -f` in the stack directory                                                                                                              |
