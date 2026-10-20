# Streaming gateway

The streaming gateway restreams Bambu Lab printer cameras to digital-signage players inside the makerspace LAN. It is a local service next to the [printer connector](printer-connector.md): it enrolls with Core, receives the camera sources and ticket keys, drives a bundled [go2rtc](https://github.com/AlexxIT/go2rtc), and exposes a small HTTPS endpoint that only accepts valid, short-lived stream tickets. Video never passes through Core. See [Signage](signage.md#streaming-gateway-and-cameras-phase-5) for the protocol.

## Components and ports

| Component | Port | Published | Purpose |
|---|---|---|---|
| streaming-gateway (HTTPS proxy) | 8443/tcp | yes | `POST /api/webrtc` (SDP offer) and `/api/ws` (MSE websocket) with a ticket; everything else is 404 |
| go2rtc WebRTC media | 8555/tcp and 8555/udp | yes | RTP media. Browsers connect to it directly after signalling, so it cannot be proxied |
| go2rtc API | 1984/tcp | no | Never published. The gateway reaches it over the internal Docker network with generated credentials (HTTP Basic); every request from another container is refused without them, and only four paths are served at all (see [Security model](#security-model)). No web UI |
| go2rtc RTSP/SRTP server | - | no | Disabled in the generated configuration |

Docker networks: `internal` (no outbound access) joins the gateway and go2rtc; the gateway also has its own `gateway_egress` network (Core, published HTTPS port), go2rtc its own `go2rtc_egress` network (the printers on the LAN, published WebRTC port) and the printer connector its own `connector_egress`. No outbound network is shared between services.

Port 8555 must be reachable from the displays on the LAN because WebRTC media does not use the HTTPS connection. go2rtc advertises `STREAM_LAN_ADDRESS:8555` as its ICE candidate; inside a container it would otherwise only see its container address. Use a fixed LAN address (DHCP reservation) for the Docker host.

## Requirements

- A DNS name that resolves to the Docker host **on the displays' network** (split-horizon DNS or a local DNS entry), for example `signage-gw.example.org`.
- A TLS certificate for that name that the display browsers trust (an internal CA installed on the displays, or a public certificate obtained with DNS-01 validation). The player is served over HTTPS from Core, so the gateway must be HTTPS as well (mixed content is blocked). Certificate and key are read from files and reloaded when they change; the container must be able to read them (uid 10001).
- The printers must be in LAN mode with the camera enabled, reachable from the Docker host on TCP 322, and have an active Bambu assignment in Core (H2D or X1 Carbon). See [Bambu setup](printer-connector.md#bambu-lab-h2d-and-x1-carbon-setup).
- Core needs application encryption keys configured (the printer access codes and the ticket signing key are stored encrypted with them).

## Setup

1. In Core create a gateway (`POST /streaming-gateways`, permission `local_services.manage`) with its **public host**, the `hostname[:port]` players use, for example `signage-gw.example.org:8443`. It must equal `STREAM_PUBLIC_HOST` below and match the certificate. In Core, use Settings, Local services, Add gateway (or the API).
2. Issue an enrollment secret (`POST /streaming-gateways/{id}/enrollments`). It is shown once and valid 15 minutes.
3. Prepare the bundle (`local-services/`):

```sh
cp .env.example .env            # set MAKERSPACE_VERSION, CORE_URL, STREAM_PUBLIC_HOST, STREAM_LAN_ADDRESS
mkdir -p secrets && chmod 700 secrets
printf '%s' 'the-one-time-enrollment-secret' > secrets/streaming-gateway-enrollment
cp fullchain.pem secrets/streaming-gateway-tls.crt
cp privkey.pem secrets/streaming-gateway-tls.key
sudo chown 10001:10001 secrets/streaming-gateway-*; chmod 600 secrets/streaming-gateway-*
# the printer connector's enrollment secret goes to secrets/printer-connector-enrollment as before
docker compose up -d
```

   From a checkout of this repository, `make local-services-up` builds both images from the source (tag `dev`, override with `LOCAL_SERVICES_VERSION=...`) and starts the bundle; `make local-services-logs` and `make local-services-down` follow and stop it. Use this until the gateway image is published with a release.

4. Assign cameras on the gateway's page (Assign camera) or with `POST /streaming-gateways/{id}/cameras {machineId, enabled}`. The machine needs an active Bambu printer assignment; the dialog offers exactly the machines without a camera that have one (`GET /local-services/camera-candidates`). `GET /local-services/cameras` shows health per camera. The gateway list shows when each gateway's credential expires; the gateway rotates it on its own during its last seven days.
5. Publish a display that has a camera widget for that machine; `GET /signage/player/live` then contains `streams`.

The gateway generates its runtime credential locally, exchanges the enrollment secret, stores its identity and the last configuration encrypted in its data volume and rotates the credential during its last seven days. The enrollment file can be removed after the first successful start. Back up the data volume as sensitive; do not clone it to a second host. The standalone `printer-connector/compose.yaml` keeps working; `local-services/compose.yaml` runs both services.

Image names: `ghcr.io/basmatireis/makerspace-core-streaming-gateway:<version>` (the Compose file uses release tags, never `latest`; to pin content as well, set `PRINTER_CONNECTOR_DIGEST=@sha256:...` and `STREAMING_GATEWAY_DIGEST=@sha256:...` in `.env` to the digests of that release, read with `docker buildx imagetools inspect <image>:<version>`; digests of an unpublished release cannot be known in advance) (built from `streaming-gateway/Dockerfile`; go2rtc is pinned to `alexxit/go2rtc:1.9.14@sha256:675c318b23c06fd862a61d262240c9a63436b4050d177ffc68a32710d9e05bae`, a digest verified against Docker Hub on the day of writing; re-verify when upgrading).

## Operation

- The gateway polls the configuration every 30 s and sends a heartbeat every 30 s. If Core is unreachable it keeps serving the last configuration, including the ticket keys (a retired key still expires on time). If Core answers 401 three times in a row (revoked credential) it switches streaming off and removes the camera credentials from go2rtc's configuration.
- go2rtc is restarted (`POST /api/restart`) when the rendered `go2rtc.yaml` changed (cameras added, removed or their address or code changed) or when the **session epoch** in the configuration changed (see below). Viewers reconnect. Ticket key rotations do not restart it. Changing a printer's address in Core reaches the gateway within a polling interval.
- **Session epoch.** Core bumps the epoch when a display is revoked or deleted, when a display is republished without a camera it showed before, and when a display loses the right to show cameras to the outside (`allowCameraOutside`). The gateway then restarts go2rtc, which drops every running WebRTC and MSE session; players reconnect with fresh tickets, which Core no longer issues for the affected display or camera. A restart that fails is retried every poll until it worked; the applied epoch is stored in the gateway's state.
- **Ticket key rotation.** `POST /local-services/ticket-key/rotation` (`local_services.manage`, audited) creates the next key as pending. Gateways receive its public key with their next poll, and it starts signing after at least 60 s (lazily, with the first ticket after that time, or at once when the endpoint is called again, which then stages yet another key). The previous key stays in the configuration for ten minutes after it stopped signing. The gateway needs no restart.
- go2rtc connects to a printer on the first viewer and disconnects after the last (verify). An idle camera therefore shows as `idle`; `unavailable` means go2rtc is down, the stream is missing, or viewers get no media.
- Healthcheck: `streaming-gateway healthcheck` reads a health file refreshed every 30 s.

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

- RTSPS source `rtspx://bblp:<LAN access code>@<ip>:322/streaming/live/1` works for both H2D and X1 Carbon with LAN-mode liveview enabled (`rtspx` = RTSPS without certificate verification, needed for the self-signed printer certificate). The H2D path/port in particular.
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
