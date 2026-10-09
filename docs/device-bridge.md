# Device Bridge architecture

Makerspace Core keeps one React application and one server-side business model across ordinary browsers, desktop hardware, and Android terminals. `frontend/src/features/terminal/device-bridge.ts` is the application-facing boundary. It exposes device information, capability discovery, one-shot NFC scans, event subscriptions, and explicit disconnection. The browser, desktop, and Android adapters implement that contract; unsupported browser operations return typed errors and do not prevent use of the rest of Core.

```text
React feature
    |
DeviceBridge contract
    |---------------- browser fallback
    |---------------- Tauri Desktop shell ---- private loopback sidecar ---- PC/SC
    `---------------- origin-scoped Android WebMessage bridge --- Reader Mode

Native client ---- managed-device credential ---- Core API
User session  ---- separate session credential -- Core API
```

The event protocol is versioned independently from the OpenAPI contract. Both native platforms emit the same scan, removal, reader-state, and capability-state shapes. Native code normalizes only technical information such as hexadecimal UID, source, reader, protocol, timestamp, sequence, and duplicate status. Core remains responsible for resolving an identifier to a future person, asset, tool, or inventory record. No mapping database exists in either bridge.

The OpenAPI-managed device API is the server source of truth. A native client authenticates itself and replaces its reported capability set. Administratively configured capabilities are intersected with the report to produce the effective set. Application modes and session policy assignment stay on the existing Managed Device. A report cannot create a device or grant user permissions.

## Supported capabilities

| Platform | NFC | Simulator | Other declared capability IDs |
| --- | --- | --- | --- |
| Ordinary browser | unavailable with a clear typed error | no | discoverable contract only |
| Desktop | USB PC/SC UID reads for compatible readers | development flag | contract supports camera, QR, barcode, scale, and label printer reports; adapters are not implemented |
| Android | Android NFC Reader Mode | debug builds only | same discoverable contract; adapters are not implemented |

Desktop uses a Tauri system WebView around the same deployed React application. Its bundled sidecar uses authenticated long polling because that naturally resumes from a sequence cursor and keeps PC/SC outside the web process. Android uses an origin-scoped WebMessage listener. The frontend receives the same normalized objects from both paths.

## Security boundaries

- Managed-device credentials and user sessions are independent and validated by the server on each request.
- Application modes are enforced in middleware. A visitor-only device cannot create or use a staff session, while logout remains available.
- NFC UID reads are technical observations and never authenticate, admit, or check in a person on their own.
- Simulated NFC remains visible to the local UI but is excluded from reported hardware capabilities, so it cannot claim physical possession to Core.
- Desktop uses an exact-origin navigation boundary, OS credential storage, an HttpOnly device cookie, local-only Tauri permissions, loopback binding, Host validation, exact CORS origins, per-request pairing authentication, bounded request bodies, and no-store responses.
- Android uses exact-origin/main-frame message checks, restricted navigation, Android Keystore encryption, HttpOnly credential delivery to WebView, production HTTPS, and fail-closed TLS handling.
- Pairing keys and tokens are never intentionally written to application logs, audit details, frontend storage, URLs, or event payloads.
- Session idle/absolute expiry and post-session destination stay server controlled. Reloads, reconnects, or native app restarts cannot make an expired staff session valid.

Known limits are described in the platform guides: [Desktop Device Bridge](desktop-device-bridge.md) and [Android terminal](android-terminal.md).
