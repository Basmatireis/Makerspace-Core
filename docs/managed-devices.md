# Managed devices

A managed device is a trusted terminal identity, not a user identity. It has a
random bearer token whose SHA-256 digest is stored in PostgreSQL. The plaintext
token is returned only at creation and rotation and must be kept by a future
desktop wrapper in OS-backed secure storage, never in React state beyond the
one-time display, localStorage, logs, or audit metadata.

The future native network layer sends the raw value in `X-Managed-Device-Token`.
It is evaluated independently of the ordinary user session. A valid user session
continues to work without a device; a revoked, expired, malformed, or unknown
device token simply supplies no device context. A token alone never logs in a
user.

The React application does not read, store, or attach this header. A future
Tauri wrapper should keep the token in platform secure storage and inject it in
the native HTTP layer after the request leaves React. The token must not be put
in localStorage, IndexedDB, a JavaScript configuration object, a URL, or a log.

Role grants can apply everywhere, to any valid managed device, or to selected
administrator-maintained device types. Revocation and expiry are checked against
PostgreSQL on every request, so device-scoped privileges disappear immediately.
The protected `master` role remains unrestricted everywhere.

Provision a device by creating its type, creating the device, copying the
one-time token into the desktop wrapper's secure storage, and configuring that
wrapper to inject the header. Rotation replaces the digest immediately; revoking
is terminal. Only revoked devices may be hard-deleted. Device tokens are bearer
credentials: TLS and trustworthy endpoint storage are required. IP addresses,
MAC addresses, hostnames, and browser fingerprints are deliberately not used as
security boundaries.

Every request validates the current digest, expiration, revocation state, and
device type in PostgreSQL. Successful authentication updates `last_seen_at` no
more than once every five minutes to avoid a write on every request. Rotating a
token invalidates the previous token in the same transaction; it can also set a
new future expiration or no expiration. Expiration removes trust but is not
terminal, while revocation is terminal.

A stolen token can impersonate only the managed device. It cannot establish a
user session, and useful access still requires a separately authenticated user
whose role grants the requested permission for that device context. Until the
token expires, is rotated, or is revoked, the server cannot distinguish its use
from the provisioned device; operators should revoke it immediately after
suspected disclosure.
