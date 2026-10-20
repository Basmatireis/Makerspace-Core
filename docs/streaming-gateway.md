# Streaming gateway

The streaming gateway restreams Bambu Lab printer cameras to digital-signage players inside the makerspace LAN. It is a local service next to the [printer connector](printer-connector.md): it enrolls with Core, receives the camera sources and ticket keys, drives a bundled [go2rtc](https://github.com/AlexxIT/go2rtc), and exposes a small HTTPS endpoint that only accepts valid, short-lived stream tickets. Video never passes through Core. See [Signage](signage.md#streaming-gateway-and-cameras-phase-5) for the protocol.

## Components and ports

| Component | Port | Published | Purpose |
|---|---|---|---|
| streaming-gateway (HTTPS proxy) | 8443/tcp | yes | `POST /api/webrtc` (SDP offer) and `/api/ws` (MSE websocket) with a ticket; everything else is 404 |
| go2rtc WebRTC media | 8555/tcp and 8555/udp | yes | RTP media. Browsers connect to it directly after signalling, so it cannot be proxied |
| go2rtc API and web UI | 1984/tcp | no | Only reachable by the gateway on the internal Docker network |
| go2rtc RTSP/SRTP server | - | no | Disabled in the generated configuration |

Port 8555 must be reachable from the displays on the LAN because WebRTC media does not use the HTTPS connection. go2rtc advertises `STREAM_LAN_ADDRESS:8555` as its ICE candidate; inside a container it would otherwise only see its container address. Use a fixed LAN address (DHCP reservation) for the Docker host.

## Requirements

- A DNS name that resolves to the Docker host **on the displays' network** (split-horizon DNS or a local DNS entry), for example `signage-gw.example.org`.
- A TLS certificate for that name that the display browsers trust (an internal CA installed on the displays, or a public certificate obtained with DNS-01 validation). The player is served over HTTPS from Core, so the gateway must be HTTPS as well (mixed content is blocked). Certificate and key are read from files and reloaded when they change; the container must be able to read them (uid 10001).
- The printers must be in LAN mode with the camera enabled, reachable from the Docker host on TCP 322, and have an active Bambu assignment in Core (H2D or X1 Carbon). See [Bambu setup](printer-connector.md#bambu-lab-h2d-and-x1-carbon-setup).
- Core needs application encryption keys configured (the printer access codes and the ticket signing key are stored encrypted with them).

## Setup

1. In Core create a gateway (`POST /streaming-gateways`, permission `local_services.manage`) with its **public host**, the `hostname[:port]` players use, for example `signage-gw.example.org:8443`. It must equal `STREAM_PUBLIC_HOST` below and match the certificate. No admin screen exists yet; use the API.
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

4. Assign cameras: `POST /streaming-gateways/{id}/cameras {machineId, enabled}`. The machine needs an active Bambu printer assignment. `GET /local-services/cameras` shows health per camera.
5. Publish a display that has a camera widget for that machine; `GET /signage/player/live` then contains `streams`.

The gateway generates its runtime credential locally, exchanges the enrollment secret, stores its identity and the last configuration encrypted in its data volume and rotates the credential during its last seven days. The enrollment file can be removed after the first successful start. Back up the data volume as sensitive; do not clone it to a second host. The standalone `printer-connector/compose.yaml` keeps working; `local-services/compose.yaml` runs both services.

Image names: `ghcr.io/basmatireis/makerspace-core-streaming-gateway:<version>` (built from `streaming-gateway/Dockerfile`; go2rtc is pinned to `alexxit/go2rtc:1.9.14@sha256:675c318b23c06fd862a61d262240c9a63436b4050d177ffc68a32710d9e05bae`, a digest verified against Docker Hub on the day of writing; re-verify when upgrading).

## Operation

- The gateway polls the configuration every 30 s and sends a heartbeat every 30 s. If Core is unreachable it keeps serving the last configuration, including the ticket keys (a retired key still expires on time). If Core answers 401 three times in a row (revoked credential) it switches streaming off and removes the camera credentials from go2rtc's configuration.
- go2rtc is restarted (`POST /api/restart`) only when the rendered `go2rtc.yaml` changed (cameras added, removed or their address or code changed). Viewers reconnect. Ticket key rotations do not restart it. Changing a printer's address in Core reaches the gateway within a polling interval.
- go2rtc connects to a printer on the first viewer and disconnects after the last (verify). An idle camera therefore shows as `idle`; `unavailable` means go2rtc is down, the stream is missing, or viewers get no media.
- Healthcheck: `streaming-gateway healthcheck` reads a health file refreshed every 30 s.

## Security model

- Core hands out tickets only for cameras used by a display's **published** camera widgets, never to revoked displays, and only while the gateway is active and the camera enabled. Tickets are Ed25519-signed, bound to display, machine and stream name, and valid 5 minutes (30 s clock skew). The gateway verifies them offline with the public keys from its configuration; the private key never leaves Core.
- The proxy only forwards `POST /api/webrtc` and websocket upgrades on `/api/ws`, only for `src` values in the configuration (go2rtc would otherwise create sources from arbitrary `src` values such as RTSP URLs or `exec:`). It forwards only `src`: the ticket, cookies, `Authorization` and `Origin` are stripped, and the ticket is never logged. Browsers from origins other than Core's (from `CORE_URL`) are refused, and CORS headers allow only that origin.
- The camera source URL contains the printer's LAN access code. Only the authenticated gateway receives it; it is written with mode 0600 into a volume shared with go2rtc, and never appears in logs or admin responses. Revoking the gateway rejects its credential immediately; tickets already issued expire within 5 minutes.
- Containers run read-only, without capabilities and with `no-new-privileges`. The go2rtc API is only on the internal network.
- Anyone on the LAN who obtains a valid ticket can watch that stream for up to five minutes; tickets are only delivered to paired, non-revoked display devices.

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
- [ ] Expired ticket and revoked display lose access within 5 minutes
- [ ] Core outage: running streams continue, new tickets are not issued, the gateway recovers after Core returns
- [ ] Camera added/removed in Core reaches go2rtc within a minute
