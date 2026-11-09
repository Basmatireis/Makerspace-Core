# Managed devices

In the UI, devices, device types and session policies are under **Settings → Access & identity → Devices & sessions** (`/settings/devices-sessions`, tabs selected by `?tab=`):

- **Managed devices** (`?tab=managed-devices`, `managed_devices.read`): a table with search, a status filter (active, expired, revoked), and columns for name, type, application modes, kiosk, last seen and status. A row opens the device page at `/settings/devices-sessions/devices/:deviceId` with the sections General, Application modes and kiosk (session policy, check-in and check-out assurance, tap check-out, survey offer and reset time), Capabilities (configured, reported and effective, from `GET /api/v1/managed-devices/{id}/hardware`) and Credential (rotate token, revoke, delete once revoked). With `managed_devices.manage` the page also offers Edit, and the table the **Pair device** (see [Pairing a kiosk](#pairing-a-kiosk)) and **New device** buttons; the one-time token is shown once after creating or rotating. The table search matches the name, type, application mode labels (for example "Visitor kiosk") and the status label.
- **Session policies** (`?tab=session-policies`, `session_policies.manage`): a table of the idle and absolute limits, the destination after expiry, the default flag and how many devices use each policy (shown with `managed_devices.read`). Create and edit open in a modal. The table search matches the policy name.
- **Device types** (`?tab=device-types`, `managed_devices.read`; changes need `managed_devices.manage`).

The former `/settings/managed-devices` and `/settings/session-policies` routes redirect to their tabs.

A managed device is a trusted kiosk identity, separate from a user identity. It has a random bearer token whose SHA-256 digest is stored in PostgreSQL. The plaintext token is returned only at creation and rotation and must be kept by native software in protected storage. It must never be put in local storage, IndexedDB, a URL, a log, or an audit event.

Native clients send the token in `X-Managed-Device-Token`. The Tauri desktop kiosk also installs it as an HttpOnly, SameSite cookie so WebView requests can carry device context without exposing the token to JavaScript. A valid user session continues to work without a device, and a device token alone never logs in a user.

Each device has one or both application modes:

- `visitor_terminal` allows the public kiosk flow. A kiosk-enabled device must have this mode and a session policy.
- `staff_ui` allows staff login and authenticated staff APIs on that device.

The API enforces these modes. A visitor-only device cannot enter or retain a staff session. Changing modes revokes the device's existing user sessions. This is the boundary that prevents a public kiosk from inheriting staff privileges; hiding staff controls in React is only an additional UX measure.

Capabilities are `nfc`, `camera`, `qr`, `barcode`, `scale`, `label_printer` and `file_upload`. `file_upload` means the kiosk's browser may offer a file picker (profile photo upload during visitor enrollment). It needs no hardware, so native clients never report it: it is effective whenever an administrator configured it. The effective set of every other capability is the intersection of configured and reported capabilities when the device has ever reported hardware; a device that never reported (a plain browser kiosk) is trusted to match its configuration. `GET /api/v1/terminal/context` and the visitor enrollment state return this effective set.

Visitor enrollment uses it for the profile photo: the picker offers "Start camera" only with `camera` and the upload only with `file_upload`. A profile photo is required exactly when the device has at least one of the two; a device with neither hides the picker and enrolls without a photo. The backend applies the same rule from the enrolling device's effective capabilities, not from what the client sends.

Configured capabilities describe what administrators permit. A native client reports what is currently present through `PUT /api/v1/managed-devices/self/hardware`; the effective set is their intersection. The device identity comes only from its credential, never from a request-body ID. Reports replace the previous reported set transactionally and write an audit event without storing the token or hardware identifiers.

Role grants can apply everywhere, to any valid managed device, or to selected administrator-maintained device types. Revocation and expiry are checked against PostgreSQL on every request, so device-scoped privileges disappear immediately. The protected `master` role remains unrestricted everywhere once its session has `strong_mfa` assurance.

Provision a device by pairing it (below), or by creating its type and device, copying the one-time token into the native client, and configuring that client's Core URL. Rotation replaces the digest immediately. Only revoked devices may be hard-deleted. IP addresses, MAC addresses, hostnames, and browser fingerprints are deliberately not security boundaries. Private browsers remain unregistered unless an administrator explicitly pairs them or uses browser binding. Installing the desktop application does not register a device until it is paired or its one-time native token is entered and accepted.

## Pairing a kiosk

A kiosk is registered the way a signage display is paired:

1. Open `/kiosk` in the kiosk's browser, or start the desktop app and enter the Core URL. An unregistered kiosk shows **This browser is not registered as a kiosk** (the desktop app: its registration screen) with a six-character code and a countdown. Codes are valid for 15 minutes; a new one appears by itself.
2. In Core open **Settings › Devices & sessions › Managed devices › Pair device** (needs `managed_devices.manage`), enter the code and fill in the same fields as for a new device: name, type, expiration, Used as, session policy, kiosk settings and capabilities.
3. Within a few seconds the kiosk collects its credential and starts: a browser opens the kiosk, the desktop app stores the token and opens Core.

How it works:

- `POST /api/v1/public/managed-devices/pairing` (public) creates a pairing request. A browser asks for `bindBrowser` and gets the poll secret as an HttpOnly, `SameSite=Strict` cookie (`__Host-makerspace_device_pairing` in production); the desktop app asks for `nativeToken`, gets the poll secret once in the body, and sends it back in `X-Device-Pairing-Secret`. The desktop app sends no `Origin`; this one operation accepts that for `nativeToken` requests only (browsers always send `Origin` on a POST, and a `bindBrowser` request without it is refused with 403 `origin_invalid`).
- A client that already presents a valid managed-device credential (cookie or `X-Managed-Device-Token`) cannot start or poll a pairing: 409 `device_already_registered`. Pairing therefore never replaces a registered device's credential; revoke the device first to pair the browser again. A signage player's credential is refused with 403 `device_mode_denied`.
- `/kiosk` offers a pairing code only when `GET /terminal/context` answers 404 (no valid device credential). A device that is registered but not set up as an entrance kiosk gets 403 `device_not_kiosk`, and the page says so instead.
- `GET /api/v1/public/managed-devices/pairing` polls the request (every 3 seconds): `pending`, `expired` or, once, `paired`.
- `POST /api/v1/managed-devices/pairing` claims the code. It creates the managed device and its capabilities in one transaction with the audit event `managed_device.paired`. The device starts with an unusable credential digest.
- The kiosk's first poll after the claim issues the real credential, deletes the request and writes `managed_device.credential_delivered` in the same transaction. A browser receives it as the managed-device cookie (the same HttpOnly cookie as browser binding, valid as long as the device); the desktop app receives the one-time token in the body. The plaintext is never stored, and a later poll, also with a copied secret, never yields it again. A device revoked or expired before the kiosk collected its credential delivers nothing.
- Codes and poll secrets are stored only as SHA-256 digests in `managed_device_pairing_requests`; kiosk and signage codes use different digests, so a display code does not register a kiosk. Neither is logged.
- Unknown, expired, already claimed and malformed codes all answer the same 422 `pairing_code_invalid`. After ten wrong codes in 15 minutes an account gets 429. A client IP may request ten codes per hour and poll 60 times per minute; at most 50 requests are open at a time. Restarting a kiosk whose code staff already claimed answers 409 `pairing_claimed`, and the kiosk collects its credential by polling.
- `DEVICE_PAIRING_ALLOWED_CIDRS` (optional, comma-separated CIDRs) restricts requesting codes to the makerspace network; other clients get 403 `pairing_network_denied`. It is separate from `SIGNAGE_PAIRING_ALLOWED_CIDRS`.

Successful authentication updates `last_seen_at` no more than once every five minutes. A stolen token can impersonate only the managed device; useful staff access still requires a separate user session and matching permission grants. Revoke or rotate a device credential immediately after suspected disclosure.

See [Desktop kiosk](desktop-device-bridge.md) for native setup and security details.
