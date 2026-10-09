# Managed devices

A managed device is a trusted terminal identity, separate from a user identity. It has a random bearer token whose SHA-256 digest is stored in PostgreSQL. The plaintext token is returned only at creation and rotation and must be kept by native software in protected storage. It must never be put in local storage, IndexedDB, a URL, a log, or an audit event.

Native clients send the token in `X-Managed-Device-Token`. The Android and Tauri desktop terminals also install it as an HttpOnly, SameSite cookie so WebView requests can carry device context without exposing the token to JavaScript. A valid user session continues to work without a device, and a device token alone never logs in a user.

Each device has one or both application modes:

- `visitor_terminal` allows the public terminal flow. A terminal-enabled device must have this mode and a session policy.
- `staff_ui` allows staff login and authenticated staff APIs on that device.

The API enforces these modes. A visitor-only device cannot enter or retain a staff session. Changing modes revokes the device's existing user sessions. This is the boundary that prevents a public terminal from inheriting staff privileges; hiding staff controls in React is only an additional UX measure.

Configured capabilities describe what administrators permit. A native client reports what is currently present through `PUT /api/v1/managed-devices/self/hardware`; the effective set is their intersection. The device identity comes only from its credential, never from a request-body ID. Reports replace the previous reported set transactionally and write an audit event without storing the token or hardware identifiers.

Role grants can apply everywhere, to any valid managed device, or to selected administrator-maintained device types. Revocation and expiry are checked against PostgreSQL on every request, so device-scoped privileges disappear immediately. The protected `master` role remains unrestricted everywhere.

Provision a device by creating its type and device, copying the one-time token into the native client, and configuring that client's Core URL. Rotation replaces the digest immediately. Only revoked devices may be hard-deleted. IP addresses, MAC addresses, hostnames, and browser fingerprints are deliberately not security boundaries. Private browsers remain unregistered unless an administrator explicitly uses browser binding. Installing the desktop application does not register a device until its one-time native token is entered and accepted.

Successful authentication updates `last_seen_at` no more than once every five minutes. A stolen token can impersonate only the managed device; useful staff access still requires a separate user session and matching permission grants. Revoke or rotate a device credential immediately after suspected disclosure.

See [Desktop terminal](desktop-device-bridge.md) and [Android terminal](android-terminal.md) for native setup and security details.
