# Desktop Device Bridge

The Desktop Device Bridge is a small Go process that exposes local hardware to the existing React application. The browser uses the platform-neutral `DeviceBridge` interface; it does not contain PC/SC code and it never receives the managed-device token.

The bridge listens on loopback only, defaults to `127.0.0.1:17321`, checks the HTTP `Host` header, permits an explicit origin allowlist, and requires `Authorization: Pairing <key>` on every protected request. The key is generated into the operating system's user configuration directory with mode `0600`. It is shown only when the operator explicitly runs `--show-pairing-key` and is kept in React memory only for the current page lifetime.

## Build and run

Run commands from `backend/`.

```sh
go run ./cmd/device-bridge --simulator
go run ./cmd/device-bridge --show-pairing-key
```

The default build reports NFC as unsupported. A hardware build uses the `pcsc` build tag and CGO:

```sh
go build -tags pcsc -o device-bridge ./cmd/device-bridge
```

- macOS links the system PC/SC framework.
- Linux requires the PC/SC headers and `pkg-config` at build time, normally `libpcsclite-dev`, and a running `pcscd` service at runtime.
- Windows requires a CGO toolchain and links `winscard`.

Configure the production Core origin explicitly. For example:

```sh
./device-bridge \
  --origins https://core.example.org \
  --core-url https://core.example.org \
  --device-token-file /secure/path/managed-device.token
```

The token file must be mode `0600` or stricter. `--core-url` and `--device-token-file` are an all-or-nothing pair. The bridge reports its current capabilities to Core, but it never sends NFC UIDs to that endpoint. Use `--tls-cert` and `--tls-key` together when browser policy or local deployment requires HTTPS on loopback.

In **Administration → Managed devices**, open **Local hardware bridge**, enter the loopback URL and pairing key, and connect. The pairing material is intentionally lost on reload.

To register the bridge with Core, create or edit the Managed Device with the required application modes and configured `nfc` capability, select native-token delivery, and store the one-time value in the protected token file. The hardware report endpoint will show `nfc` as effective only when both the administrator configuration and current bridge report contain it.

## Protocol

Protocol version 1 provides:

- `GET /health`, an unauthenticated loopback liveness check;
- `GET /v1/info`, authenticated device and capability state;
- `GET /v1/events?after=<sequence>&wait=25s`, authenticated long polling with a monotonic reconnect cursor;
- `POST /v1/simulator/events`, available only when `--simulator` is enabled.

Events distinguish NFC scans, tag removal, reader connection changes, and unsupported capability states. NFC UIDs are normalized hexadecimal technical identifiers. Duplicate reads inside the debounce window are marked, while one-shot scans ignore duplicates. Reader names are metadata only and never authorize access.

The simulator accepts `scan <uid>`, `duplicate <uid>`, `remove`, `disconnect`, `reconnect`, and `unsupported` on standard input. The simulator HTTP endpoint accepts the same actions as JSON and is absent when the flag is disabled.

## Hardware limits

The PC/SC adapter enumerates readers and uses the common `FF CA 00 00 00` UID APDU. Some readers, tags, and vendor drivers do not implement that command. Those devices produce an explicit `uid_read_unsupported` capability event instead of a fabricated identifier. Reader-specific APDUs, USB drivers, card-sector reads, and business identity mapping are intentionally outside this bridge.

The process logs operational state only. Pairing keys, managed-device tokens, NFC UIDs, HTTP bodies, and authorization headers must not be logged. Production service packaging should run it as the signed-in desktop user with the narrow origin list and a protected token file.

Common failures are intentionally visible:

- `unsupported` means the binary lacks the `pcsc` tag or CGO support.
- `pcsc_service_unavailable` means the operating-system smart-card service could not be opened.
- `disconnected` means no PC/SC reader is enumerated; check the cable, OS service, and vendor support.
- `uid_read_unsupported` means the reader/tag rejected the generic UID APDU; a reader-specific implementation would be required.
- HTTP 401 from the loopback API means the pairing key is wrong; HTTP 403 usually means the Core origin or loopback Host was rejected.
- A browser network error with an HTTPS Core deployment can require locally trusted TLS for the bridge, depending on browser private-network policy.
