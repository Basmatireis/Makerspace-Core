# Streaming gateway

The streaming gateway restreams Bambu Lab printer cameras to digital-signage players inside the makerspace LAN. It is a local service next to the [printer connector](printer-connector.md): it enrolls with Core, receives the camera sources and ticket keys, drives a bundled [go2rtc](https://github.com/AlexxIT/go2rtc), and exposes a small HTTPS endpoint that only accepts valid, short-lived stream tickets. Video never passes through Core. See [Signage](signage.md#streaming-gateway-and-cameras-phase-5) for the protocol.

## Components and ports

| Component | Port | Published | Purpose |
|---|---|---|---|
| streaming-gateway (HTTPS proxy) | 8443/tcp | yes | `POST /api/webrtc` (SDP offer) and `/api/ws` (MSE websocket) with a ticket; everything else is 404 |
| go2rtc WebRTC media | 8555/tcp and 8555/udp | yes | RTP media. Browsers connect to it directly after signalling, so it cannot be proxied |
| go2rtc API | 1984/tcp | no | Never published. The gateway reaches it over the internal Docker network with generated credentials (HTTP Basic); every request from another container is refused without them, and only four paths are served at all (see [Security model](#security-model)). No web UI |
| go2rtc RTSP/SRTP server | - | no | Disabled in the generated configuration |

Docker networks: `internal` (no outbound access) joins the gateway and go2rtc; the gateway also has its own `gateway_egress` network (Core, published HTTPS port), go2rtc its own `go2rtc_egress` network (the printers on the LAN, published WebRTC port) and, in the combined `local-services` stack, the printer connector its own `connector_egress`. No outbound network is shared between services.

Port 8555 must be reachable from the displays on the LAN because WebRTC media does not use the HTTPS connection. go2rtc advertises `STREAM_LAN_ADDRESS:8555` as its ICE candidate; inside a container it would otherwise only see its container address. Use a fixed LAN address (DHCP reservation) for the Docker host.

## Requirements

- A DNS name that resolves to the Docker host **on the displays' network** (split-horizon DNS or a local DNS entry), for example `signage-gw.example.org`.
- A TLS certificate for that name that the display browsers trust: either obtained by the gateway itself from Let's Encrypt (ACME mode, DNS-01 via Cloudflare) or supplied as files (file mode). The player is served over HTTPS from Core, so the gateway must be HTTPS as well (mixed content is blocked). See [TLS](#tls).
- The printers must be in LAN mode with the camera enabled, reachable from the Docker host on TCP 322, and have an active Bambu assignment in Core (H2D or X1 Carbon). See [Bambu setup](printer-connector.md#bambu-lab-h2d-and-x1-carbon-setup).
- Core needs application encryption keys configured (the printer access codes and the ticket signing key are stored encrypted with them).

## Setup

1. In Core create a gateway (`POST /streaming-gateways`, permission `local_services.manage`) with its **public host**, the `hostname[:port]` players use, for example `signage-gw.example.org:8443`. It must equal `STREAM_PUBLIC_HOST` below and match the certificate. In Core, use Settings, Local services, Add gateway (or the API).
2. Issue an enrollment secret (`POST /streaming-gateways/{id}/enrollments`). It is shown once and valid 15 minutes.
3. Prepare the streaming gateway bundle (`streaming-gateway/`, or `local-services/` to run the printer connector as well) as described in [Hosting](hosting.md#stack-3-streaming-gateway-makerspace-streaming): set `MAKERSPACE_VERSION`, `CORE_URL`, `STREAM_PUBLIC_HOST`, `STREAM_LAN_ADDRESS` and `STREAM_ENROLLMENT_SECRET` in `.env`, then either set `ACME_EMAIL` and `CLOUDFLARE_DNS_API_TOKEN` (the gateway gets its Let's Encrypt certificate itself) or put `fullchain.pem` and `privkey.pem` into `certs/` (readable for uid 10001), and run `docker compose up -d`.

4. Assign cameras on the gateway's page (Assign camera) or with `POST /streaming-gateways/{id}/cameras {machineId, enabled}`. The machine needs an active Bambu printer assignment; the dialog offers exactly the machines without a camera that have one (`GET /local-services/camera-candidates`). `GET /local-services/cameras` shows health per camera. The gateway list shows when each gateway's credential expires; the gateway rotates it on its own during its last seven days.
5. Publish a display that has a camera widget for that machine; `GET /signage/player/live` then contains `streams`.

The gateway generates its runtime credential locally, exchanges the enrollment secret (`STREAM_ENROLLMENT_SECRET`), stores its identity and the last configuration encrypted in its data volume and rotates the credential during its last seven days. After the first successful start the variable is ignored (the gateway logs that once) and can be removed; without an identity and without a secret the gateway exits with instructions. `STREAM_ENROLLMENT_SECRET_FILE` (a path) is still honoured as a legacy fallback when the variable is empty. Back up the data volume as sensitive; do not clone it to a second host. `streaming-gateway/compose.yaml` runs the gateway and go2rtc; `local-services/compose.yaml` runs the printer connector as well.

Image names: `ghcr.io/basmatireis/makerspace-core-streaming-gateway:<version>` (the Compose file uses release tags, never `latest`; to pin content as well, set `STREAMING_GATEWAY_DIGEST=@sha256:...` (and `PRINTER_CONNECTOR_DIGEST` in `local-services`) in `.env` to the digests of that release, read with `docker buildx imagetools inspect <image>:<version>`; digests of an unpublished release cannot be known in advance) (built from `streaming-gateway/Dockerfile`; go2rtc is pinned to `alexxit/go2rtc:1.9.14@sha256:675c318b23c06fd862a61d262240c9a63436b4050d177ffc68a32710d9e05bae`, a digest verified against Docker Hub on the day of writing; re-verify when upgrading).

## TLS

The gateway decides at start how it gets its certificate:

1. **File mode** when the certificate files exist (`STREAM_TLS_CERT_FILE` and `STREAM_TLS_KEY_FILE`; the Compose files set `/certs/fullchain.pem` and `/certs/privkey.pem`, the optional `./certs` mount). They are reloaded when their modification time changes (checked at most once a minute). Files win over ACME settings. If only one of the two files exists the gateway refuses to start.
2. **ACME mode** when no files exist and both `ACME_EMAIL` and `CLOUDFLARE_DNS_API_TOKEN` are set.
3. Otherwise the gateway exits with a message that lists both options.

**ACME mode** is built on the [lego](https://github.com/go-acme/lego) library (the ACME client Traefik uses; only its Cloudflare DNS provider is linked in). It validates with DNS-01 because the gateway is typically LAN-only: a public DNS record at Cloudflare points to a private LAN address, so HTTP-01 and TLS-ALPN-01 cannot work.

| Variable | Meaning |
|---|---|
| `STREAM_PUBLIC_HOST` | the domain is its host part (`signage-gw.example.org:8443` gives `signage-gw.example.org`); it must be a DNS name, not an IP address, and not a wildcard |
| `ACME_EMAIL` | account address for Let's Encrypt (expiry notices); setting it accepts the Let's Encrypt subscriber agreement |
| `CLOUDFLARE_DNS_API_TOKEN` | scoped API token with **Zone > Zone > Read** and **Zone > DNS > Edit** for the one zone; never logged |
| `ACME_CA_DIR` | optional ACME directory, default `https://acme-v02.api.letsencrypt.org/directory`; staging: `https://acme-staging-v02.api.letsencrypt.org/directory` |
| `ACME_DNS_RESOLVERS` | optional, default `1.1.1.1:53,1.0.0.1:53`: recursive resolvers (IP[:port]) for zone discovery and propagation checks |

- **Resolvers.** The propagation checks never use the host's or container's resolver. A router with dnsmasq rebind protection (OpenWrt) refuses public names that point to private addresses, which would otherwise break the check; `ACME_DNS_RESOLVERS` avoids that. Let's Encrypt itself validates from the internet and is unaffected. The container needs outbound access to the ACME directory, `api.cloudflare.com` and the resolvers and Cloudflare's name servers (port 53).
- **Storage.** The ACME account key, the certificate and its key live in the data volume under `acme/<ca>/` (directory mode 0700, files 0600), one directory per CA, so switching between staging and production never mixes certificates. They are reused after restarts; a stored certificate for another domain or an expired one is ignored.
- **First start.** Port 8443 refuses TLS handshakes until a certificate exists (the log says `tls: waiting for certificate`, then `certificate obtained`, usually after one or two minutes). Configuration polling and heartbeats continue meanwhile.
- **Renewal.** Checked every 12 hours (plus up to one hour of jitter); a certificate with fewer than 30 days left is renewed and swapped in with no restart or dropped connection. The old certificate keeps being served while renewal fails.
- **Failures and rate limits.** After a failure the gateway waits 10 minutes, doubling up to 6 hours (plus 10% jitter) before it retries, which keeps it below Let's Encrypt's limit of 5 failed validations per hostname and hour. The limit of 5 identical certificates per week is avoided because the certificate is stored: do not delete the data volume repeatedly. Use the staging CA while experimenting.
- **Logs.** The log shows progress and errors but never the token, the account key or the certificate key.
- **Token scope.** The token can edit DNS records of its zone, so restrict it to that zone and keep `.env` private (mode 0600). A compromised token allows DNS changes, not access to the gateway or Core.

Setup steps for Cloudflare are in [Hosting](hosting.md#stack-3-streaming-gateway-makerspace-streaming). Displays need to resolve the name; if a router blocks it, see [Signage player: DNS on the kiosk](signage-player.md#dns-on-the-kiosk-names-that-point-to-a-private-address).

## Development

Everything on one machine next to `make dev` (Core API on `localhost:8080`, app and player on `http://localhost:5173`). The commands (`make dev-streaming`, `-logs`, `-down`), the Core steps and the one-time certificate trust are in [Hosting](hosting.md#streaming-gateway-in-development); in short:

1. Start Core (`make dev`, then `make migrate-up`) and, if you want printer status, `make dev-connector`.
2. In Core open Settings, Local services, Add gateway, with public host `localhost:8443`, and put the enrollment secret into `streaming-gateway/.env` as `STREAM_ENROLLMENT_SECRET`.
3. `make dev-streaming` creates a TLS certificate for `localhost` in `streaming-gateway/certs/` (mkcert when installed, otherwise self-signed), builds the gateway from source and starts it with go2rtc. With a self-signed certificate the browser must accept it once at https://localhost:8443.
4. Assign a camera, put a camera widget into a scene and publish a display; open http://localhost:5173/player/ to pair the player.

The development file (`streaming-gateway/compose.development.yaml`) differs from production on purpose: `CORE_URL` is `http://host.docker.internal:8080` with `STREAM_ALLOW_HTTP=true`, `STREAM_ALLOWED_ORIGIN` is the Vite origin `http://localhost:5173` (by default the gateway only accepts browsers from `CORE_URL`'s origin), the WebRTC candidate is `127.0.0.1:8555`, and both ports are published on `127.0.0.1` only. A real picture needs a reachable Bambu printer with an active assignment; without one the camera widget shows its fallback.

## Operation

- **Connecting to another gateway.** To connect a daemon to a different or newly created connector or gateway, put the new enrollment secret into `STREAM_ENROLLMENT_SECRET` and restart. If the secret differs from the one used for the stored identity, the daemon enrolls with it and replaces its local identity. If Core rejects the new secret, the daemon keeps running with the old identity and logs an error. An unchanged secret is ignored and can be removed. If the log says "Core rejects this connector's credential (revoked or deleted)", the gateway was revoked or deleted: create a new one, put its secret into `.env` and restart.
- **Deleting a gateway.** `DELETE /streaming-gateways/{id}` (`local_services.manage`, `expectedVersion`) works for pending, active, disabled and revoked gateways. In one transaction the credentials, enrollments, camera assignments and camera states are deleted and `streaming_gateway.deleted` is audited. A running gateway gets 401 on its next request and, after three, switches streaming off; its cameras must be assigned to another gateway. No session epoch bump is needed because the gateway itself stops serving. A new enrollment secret can be issued for pending, active and disabled gateways (revoked ones answer 409 `streaming_gateway_revoked`) and invalidates an earlier unused one.
- **Re-enrolling an enrolled gateway.** To move a gateway to another host or recover after losing its data volume without losing its camera assignments, issue a new enrollment secret for it (Settings, Local services, New enrollment secret; permission `local_services.manage`). Issuing is audited (`streaming_gateway.enrollment_issued`) and does not touch the current credential: the running gateway keeps working until the new secret is used. When a daemon enrolls with it, Core in one transaction makes the new credential current, revokes all earlier credentials, bumps the configuration revision and audits `streaming_gateway.reenrolled` (no secrets). The gateway keeps its id, cameras and lifecycle. The old gateway, if still running, gets 401 and logs the actionable error. Put the secret into `STREAM_ENROLLMENT_SECRET` on the new host and start.
- The gateway polls the configuration every 30 s and sends a heartbeat every 30 s. If Core is unreachable it keeps serving the last configuration, including the ticket keys (a retired key still expires on time). If Core answers 401 three times in a row (revoked credential) it switches streaming off and removes the camera credentials from go2rtc's configuration.
- go2rtc is restarted (`POST /api/restart`) when the rendered `go2rtc.yaml` changed (cameras added, removed or their address or code changed) or when the **session epoch** in the configuration changed (see below). Viewers reconnect. Ticket key rotations do not restart it. Changing a printer's address in Core reaches the gateway within a polling interval.
- **Session epoch.** Core bumps the epoch when a display is revoked or deleted, when a display is republished without a camera it showed before, and when a display loses the right to show cameras to the outside (`allowCameraOutside`). The gateway then restarts go2rtc, which drops every running WebRTC and MSE session; players reconnect with fresh tickets, which Core no longer issues for the affected display or camera. A restart that fails is retried every poll until it worked; the applied epoch is stored in the gateway's state.
- **Ticket key rotation.** `POST /local-services/ticket-key/rotation` (`local_services.manage`, audited) creates the next key as pending. Gateways receive its public key with their next poll, and it starts signing after at least 60 s (lazily, with the first ticket after that time, or at once when the endpoint is called again, which then stages yet another key). The previous key stays in the configuration for ten minutes after it stopped signing. The gateway needs no restart.
- go2rtc connects to a printer on the first viewer and disconnects after the last (verify). An idle camera therefore shows as `idle`; `unavailable` means go2rtc is down, the stream is missing, or viewers get no media.
- Healthcheck: `streaming-gateway healthcheck` reads a health file refreshed every 30 s. It reports the process and the Core sync loop, not the certificate: a gateway that still waits for its first ACME certificate is healthy (restarting it would not help). The certificate state is a separate field `tls` in the health file (`files`, `waiting` or `ready`) and, to Core, the heartbeat: health state `degraded` with the summary `tls: waiting for certificate` until the first certificate exists, and `tls: certificate renewal failing` when a certificate has fewer than 14 days left and renewals keep failing.

## Security model

- Core hands out tickets only for cameras used by a display's **published** camera widgets, never to revoked displays, only while the gateway is active and the camera enabled, and, for a display that is "visible from outside", only when its `allowCameraOutside` setting is on. Tickets are Ed25519-signed, bound to display, machine and stream name, and valid 5 minutes (30 s clock skew; the gateway also rejects a ticket whose expiry lies further ahead than that). The gateway verifies them offline with the public keys from its configuration; the private key never leaves Core.
- **What a ticket guarantees.** A ticket gates the start of a session. The proxy ends an MSE websocket when its ticket expires (the player refreshes the ticket and reconnects). WebRTC media flows directly between go2rtc and the browser (port 8555) and cannot be cut by the proxy, so a running WebRTC session lasts until the player or go2rtc closes it. Core therefore (a) lists displays revoked or deleted in the last 24 hours in the gateway configuration (`revokedDisplayIds`), and the proxy refuses their tickets even while still valid, and (b) bumps the session epoch on the events above, which makes the gateway restart go2rtc. Effect: after a revocation, republish or setting change, new sessions are refused as soon as the gateway has polled (up to 30 s; longer if it cannot reach Core) and running sessions end then; a gateway that cannot reach Core keeps serving the last configuration, so revocation does not reach it until it is back. A ticket that was issued legitimately but not yet used for a revoked display is covered by (a) for 24 hours.
- The proxy only forwards `POST /api/webrtc` and websocket upgrades on `/api/ws`, only for `src` values in the configuration (go2rtc would otherwise create sources from arbitrary `src` values such as RTSP URLs or `exec:`). It forwards only `src`: the ticket, cookies, `Authorization` and `Origin` are stripped, and the ticket is never logged. Browsers from origins other than Core's (from `CORE_URL`) are refused, and CORS headers allow only that origin.
- The camera source URL contains the printer's LAN access code. Only the authenticated gateway receives it; it is written with mode 0600 into a volume shared with go2rtc, and never appears in the gateway's logs or admin responses. Revoking the gateway rejects its credential immediately; tickets already issued expire within 5 minutes.
- **go2rtc API.** go2rtc's API exposes stream sources (with access codes) and can restart or create streams, so it is never published and is protected twice: the gateway generates a random user name and password once, keeps them encrypted in its state and renders them as `api.username`/`api.password`; go2rtc then answers 401 to every request that does not come from inside its own container (the container healthcheck does). The proxy and the gateway's own client send them; the client's `Authorization` header never reaches go2rtc. In addition `api.allow_paths` limits go2rtc to `/api/streams`, `/api/webrtc`, `/api/ws` and `/api/restart`: configuration dumps, mp4/hls/mjpeg consumers, `/api/exit` and the web UI answer 404 even with credentials. go2rtc 1.9.14 has no switch for its other modules, but its `exec` and `echo` sources are disabled through empty-effect allow lists in the generated configuration, and go2rtc refuses exec-like sources created through the API. Residual risk: go2rtc listens on all interfaces of its own container (`go2rtc_egress` as well as `internal`); the only other host that can reach port 1984 is something with access to the Docker host's networks, and it still needs the credentials. A holder of the credentials (the gateway only) could create RTSP streams to arbitrary hosts.
- **go2rtc logs.** go2rtc logs stream sources, which contain the access codes, at its more verbose levels. The generated configuration uses level `error`; `GO2RTC_LOG_LEVEL` accepts only `error` or `fatal`, and the gateway refuses to start with another value. Error lines in go2rtc 1.9.14 were observed to carry the failing address but not the stream URL; this is not guaranteed for future versions, so Compose also limits the go2rtc log to a local file driver with 5 MB x 3 files. Do not ship these logs to a central system.
- Containers run read-only, without capabilities and with `no-new-privileges`. The go2rtc API is only on the internal network.
- Anyone on the LAN who obtains a valid ticket can watch that stream for up to five minutes; tickets are only delivered to paired, non-revoked display devices.

- **Failed authentication limit.** Core answers 429 to an address after 20 failed gateway authentications or enrollments within 15 minutes. A gateway whose credential was revoked or whose enrollment secret is wrong keeps retrying and blocks its own address (and other gateways behind it) for that time; remove or re-enroll it. Valid requests are not counted.

## Assumptions to verify on hardware

The following came from documentation and the go2rtc container, not from a Bambu printer yet:

- RTSPS source `rtspx://bblp:<LAN access code>@<ip>:322/streaming/live/1`: **verified on a Bambu Lab H2D and an X1 Carbon on 2026-10-20** (LAN mode, liveview on; H.264, delivered to Chromium over WebRTC/UDP). (`rtspx` = RTSPS without certificate verification, needed for the self-signed printer certificate.)
- go2rtc stops the printer connection after the last viewer (printers allow few concurrent RTSP clients).
- go2rtc's `/api/streams` reports no resolution or frame rate, so those fields stay empty.
- Browsers on the display accept the advertised ICE candidate `STREAM_LAN_ADDRESS:8555`, over UDP and the TCP fallback.

## Hardware validation checklist

- [ ] H2D and X1 Carbon streaming at the same time from one gateway
- [ ] 12-24 h continuous operation: no memory growth in go2rtc and the gateway, no stuck streams, certificate reload works
- [ ] Several viewers (several displays, several tabs) on one camera; the printer sees one connection
- [ ] Latency of WebRTC (target under 1 s) and of the MSE fallback; behaviour on Wi-Fi displays
- [ ] Printer reboot or network loss: the stream recovers without restarting the gateway
- [ ] An expired ticket loses access within 5 minutes; a revoked display, a republish without the camera and switching `allowCameraOutside` off end running WebRTC and MSE sessions within about a minute (session epoch restart)
- [ ] Core outage: running streams continue, new tickets are not issued, the gateway recovers after Core returns
- [ ] Camera added/removed in Core reaches go2rtc within a minute
