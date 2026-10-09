# Desktop terminal

Makerspace Core Desktop is a Tauri application that loads the existing Core web application in the operating system WebView and adds local hardware support. It follows the same model as the Android terminal: Core remains the source of UI and business rules, while the native shell owns the managed-device credential, navigation boundary, and hardware adapter.

The desktop app bundles the Go Device Bridge as a private sidecar. The shell starts it on `127.0.0.1:17321`, creates the pairing key, restricts it to the configured Core origin, and injects the loopback connection into the web application. Operators do not copy a pairing key or run a second process. Ordinary browsers continue to use the browser fallback and do not become Managed Devices automatically.

## Register a desktop

1. In **Administration → Managed devices**, create or edit a device with the required application modes and capabilities. Select native-token delivery.
2. Start Makerspace Core Desktop and enter the exact Core origin plus the one-time managed-device token.
3. The shell verifies the token with Core before loading the web application. An entrance device with `visitor_terminal` opens `/terminal`; other permitted devices open `/login`.

Production registrations require HTTPS. Debug builds also accept loopback HTTP for local development. A revoked, expired, or invalid token leaves the app on its registration screen with an actionable error. Set `MAKERSPACE_DESKTOP_RESET_REGISTRATION=1` for one launch to remove the saved registration and credential.

The token is stored in the operating system credential store and installed into the WebView as the same HttpOnly, SameSite managed-device cookie used by Android. It is passed once to the bundled sidecar over stdin. It is never placed in command arguments, environment variables, URLs, JavaScript storage, configuration files, or logs. Non-secret registration metadata and the loopback pairing key live in the app configuration directory; private files use mode `0600` on Unix.

The remote Core page has no Tauri command permissions. Navigation is limited to the exact registered Core origin, and only the bundled registration page can invoke registration. The managed-device identity and a staff user session remain separate credentials. Closing or restarting the native app does not extend a server-expired user session.

## Build and test

Install the normal Tauri 2 prerequisites for the target operating system, Go, Rust, Node.js, and pnpm. Run from the repository root:

```sh
make test-desktop
make build-desktop
```

`build-desktop` compiles the PC/SC-enabled Go sidecar for the Rust host target and then creates the platform Tauri bundle. Platform hardware prerequisites are:

- macOS: the system PC/SC framework;
- Linux: PC/SC headers and `pkg-config` at build time, normally `libpcsclite-dev`, plus `pcscd` at runtime;
- Windows: a CGO toolchain and WinSCard.

The simulator checkbox exists only in debug builds. Simulated NFC is visible in the UI but is excluded from capability reports to Core.

## Loopback protocol

Protocol version 1 provides:

- `GET /health`, an unauthenticated loopback liveness check;
- `GET /v1/info`, authenticated device and capability state;
- `GET /v1/events?after=<sequence>&wait=25s`, authenticated long polling with a monotonic reconnect cursor;
- `POST /v1/simulator/events`, present only when the debug simulator is enabled.

The sidecar binds only to loopback, checks the HTTP `Host` header, permits one exact Core origin, and requires `Authorization: Pairing <key>` on protected requests. Events contain normalized technical observations such as reader state, UID, source, timestamp, and sequence. They do not authenticate, admit, or check in a person.

The PC/SC adapter enumerates readers and uses the common `FF CA 00 00 00` UID APDU. Readers or tags that do not implement it return `uid_read_unsupported`. Concrete USB drivers, reader-specific APDUs, card-sector reads, and identity mapping remain outside this implementation.

For development and diagnostics, the Go sidecar can still run separately from `backend/`:

```sh
go run ./cmd/device-bridge --simulator
go run ./cmd/device-bridge --show-pairing-key
go build -tags pcsc -o device-bridge ./cmd/device-bridge
```

The standalone mode retains manual loopback pairing in the web UI. It is a diagnostic path; the packaged desktop app is the normal desktop deployment.
