# Authentication and sessions

## Email/password identity

Version 1 has exactly one authentication method: an `email_password` AuthIdentity linked to an Account. The normalized login email is independent of the Person's optional contact email; changing one never silently changes the other. Failed login returns the same `invalid_credentials` behavior for an unknown email, wrong password, disabled account, unset password, or reset-required credential.

Login attempts are bounded by a process-local 15-minute window keyed by a SHA-256 digest of the source address and normalized login email. The in-memory limiter permits ten attempts per key, has a fixed 4,096-key bound, and clears a key after successful login. It is deliberately a single-process defense for the initial deployment shape, not a distributed rate-limit service; neither email nor source address is used as a log or metric label.

New passwords contain 12–128 Unicode characters, at most 1,024 encoded bytes, and are rejected when present in the [attributed bundled common-password list](../backend/internal/security/COMMON_PASSWORDS_LICENSE.md). Existing-password fields remain opaque and accept older valid credentials so future policy changes cannot lock users out. Passwords are hashed with Argon2id using a random 16-byte salt, 64 MiB memory, three iterations, one lane, and a 32-byte result. Only the encoded hash is stored; a successful login replaces a valid older Argon2id encoding when its parameters no longer match these values.

No password, hash, reset token, session token, cookie, Authorization header, or request body may enter structured logs or audit metadata.

## Server-side sessions

Successful `POST /api/v1/auth/login` creates random session and CSRF tokens. PostgreSQL stores SHA-256 digests, not usable raw tokens. Session rows record the account, identity, `password` authentication method, creation/last-seen times, idle and absolute expiry, and revocation state. Login locks the target Account for the credential check and session insert. Disablement, identity changes, administrative password operations, reset redemption, and own-password changes use the same serialization point, so a concurrently created session cannot survive a committed revocation and a password change cannot bypass a committed reset requirement.

Default limits are a sliding six-hour idle lifetime and a fixed 72-hour absolute lifetime. The server evaluates current account status, credential reset state, and effective permissions on every request, so disablement and role changes take effect without waiting for a cached claim or JWT to expire.

Requests may independently carry the optional `X-Managed-Device-Token` bearer
credential. It answers which trusted terminal is making the request and never
answers who the user is. It is not merged into the session cookie. Unknown,
malformed, expired, and revoked device credentials are treated as absent, so
global permissions on a valid user session keep working while device-scoped
permissions disappear immediately. See [managed devices](managed-devices.md).

Development uses:

- `makerspace_session`: HttpOnly, SameSite=Lax, Path=/
- `makerspace_csrf`: readable by the same-origin frontend, SameSite=Lax, Path=/

TLS deployments set `SESSION_COOKIE_SECURE=true`; production startup refuses a false value. Secure deployments use the corresponding `__Host-` cookie names and require HTTPS, Path=/, and no Domain attribute.

Every unsafe request must carry an `Origin` exactly matching `PUBLIC_BASE_URL`. Every unsafe authenticated request must also mirror the readable CSRF cookie in `X-CSRF-Token`; the server constant-time compares the cookie and header, then verifies their digest against the current session. Permissive CORS is not enabled; the supported browser topology is same-origin.

`PUT /auth/password` verifies the current password, sets a new hash, revokes other sessions, and rotates the current session/cookies. Logout revokes the current session and expires both cookies. Disabled/deleted accounts, expired/revoked sessions, and reset-required credentials cannot authenticate.

## Administrative password actions

Administrative set and reset are separate capabilities:

- `PUT /accounts/{accountId}/password` requires `accounts.password.set`, replaces the credential, revokes sessions/reset tokens, and never returns or logs the password.
- `POST /accounts/{accountId}/password-reset` requires `accounts.password.reset`, invalidates password login, revokes sessions, and returns one reset link exactly once. Only a digest is persisted.
- `POST /auth/password-reset/complete` accepts the raw token and new password in its JSON body. It consumes the 30-minute token and revokes stale sessions.

The frontend reset link stores the token in the URL fragment, not the query string, so browsers do not send it in HTTP request targets or referrers. The operator must deliver the one-time link through an approved out-of-band channel; v1 does not add an email delivery service. Authentication and reset responses use `Cache-Control: no-store`.

All password administration writes an atomic, secret-free audit event. See [authorization](authorization.md) for permission rules and [operations](operations.md) for bootstrap/recovery procedures.
