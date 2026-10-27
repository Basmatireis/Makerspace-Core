# Known limitations

Deliberate gaps in the current implementation. Each entry says what is missing and what a fix needs; none of them is a silent behaviour.

## Storage failure recovery

File deletion commits the metadata row before the blob is removed from the store, and profile-image replacement or failed workflow cleanup can ignore a storage-delete error. A storage failure can therefore leave an orphaned blob, or report an error after the Person is already deleted. Complete physical erasure under failure needs a recoverable deletion record with a retry command and failure-injection tests. No queue or distributed transaction is used.

## Retention of expired authentication rows

`admin cleanup` prunes sessions, legacy reset tokens and audit events. Newer challenge and OIDC-flow rows, visitor-enrollment contexts and PIN throttle history are rejected once expired but are not pruned, so they can keep delivery addresses or keyed identifiers past their validity. A bounded cleanup needs a retention decision and tests that active tokens survive.

## Rate limiting is per process

Password, attendance and re-authentication limits, device request limits and signage pairing limits are held in memory. They are bounded (least recently active keys are evicted) and reset on restart. This matches the single-instance deployment; PIN back-off and challenge limits are persistent in PostgreSQL.

## Service boundaries

Some administrative and visitor orchestration reads other features' persistence, and SCIM PATCH transformation lives in the HTTP adapter. Moving them behind service boundaries is a focused refactor that has not been done.

## External interoperability

OIDC and SCIM are covered by local handshake and provisioning tests, not by every real upstream provider lifecycle (concurrent linking and unlinking, key rotation during provider edits). Shared-kiosk behaviour beyond the tested flows (long camera sessions, abandoned forms, configuration changes during enrollment) is not certified on kiosk hardware.

## CI and release policy

CI skips documentation-only changes, which interacts with required status checks. Release tags must be cut from `main`, but the workflow validates tag syntax without checking ancestry.
