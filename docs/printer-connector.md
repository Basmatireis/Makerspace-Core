# Makerspace Printer Connector

The Makerspace Printer Connector is a single Go process that runs inside a printer network and makes outbound HTTPS requests to Makerspace Core. One instance can supervise multiple printers and adapter kinds. It does not expose an inbound application port, require host networking, or need device access.

The initial build includes a simulator adapter. Manufacturer transports such as Bambu Lab, Moonraker, and OctoPrint belong behind the connector adapter interface and are not part of this release.

## Domain boundaries

Core remains authoritative for Machines, printer profiles, input units, slots, spool assignments, prints, MachineJobs, pricing, inventory, and audit history. A connector assignment binds one enabled printer profile to one connector and one adapter configuration. The active-assignment database constraint prevents two connectors from controlling the same profile.

An observed run represents a physical printer job and is exposed to staff as a **print** (display ID `PR-YYYY-NNNNNN`, see [Machine logbook](machine-logbook.md#prints)). Core derives the print's facts from the events a connector sends: `fileName` (up to 255 characters) from run-start and progress payloads, `percent` (0-100) and `remainingSeconds` from progress payloads (giving progress and estimated end), start and end from event times and the terminal outcome, and, from a `consumption_report`, the reported grams, quantity basis (estimated or actual), and spool. The spool is the one mounted in the reported `slotExternalId` at that time, otherwise the machine's only mounted spool; an ambiguous report leaves the spool unresolved. Missing or invalid keys are ignored. Replayed events never change a print. Staff link an ended print to a Machine Job, or create a job from it, which replaces the manual run's times and usage; a print that is still printing cannot be linked yet. It is also separate from a Print Attempt until a staff member explicitly links the two. After linking, verified progress and terminal events can advance that attempt. The connector never creates a Print Attempt or MachineJob; it only reports prints. Consumption reports enter the existing pending reconciliation workflow and cannot deduct inventory, change pricing, or bill an Order until staff approves them against the linked MachineJob.

Printer slot observations remain observations. They do not replace Core spool assignments. Administrators should resolve any discrepancy in the existing printer profile and inventory screens.

## Enrollment and credentials

Connector identities are separate from people, browser sessions, and Managed Devices. The database stores SHA-256 digests of enrollment and runtime tokens. Printer adapter secrets use the configured Core application encryption key and never appear in administration responses.

1. Give the operator `printer_connectors.read`, `printer_connectors.manage`, and `printer_connectors.credentials.manage` as appropriate. Assigning a printer also requires `machines.manage`; linking a print to a job requires `machine_jobs.edit`.
2. In **Settings → Printer connectors**, create a connector and choose **Enroll**.
3. Copy the one-time 43-character secret into the deployment's secret file. The secret expires after 15 minutes and is displayed once.
4. Start the connector. It generates its runtime credential locally, exchanges the enrollment secret, encrypts the resulting identity in its data volume, and begins polling configuration.

Runtime credentials expire after 90 days. The connector rotates its own credential during the final seven days. Core accepts the prior credential for a 24-hour handover window so a successful server response followed by a local disk failure can recover safely. Revocation immediately rejects all credentials, invalidates open enrollment, ends assignments, and is audited.

All production Core URLs must use HTTPS. Plain HTTP is accepted only when `CONNECTOR_ALLOW_HTTP=true`, which is intended for an isolated local development stack.

## Docker deployment

Release images use this name:

```text
ghcr.io/basmatireis/makerspace-core-printer-connector:<version>
```

Download the printer connector Compose bundle from the matching Core release, then:

```sh
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
printf '%s' 'the-one-time-enrollment-secret' > secrets/printer-connector-enrollment
chmod 600 secrets/printer-connector-enrollment
docker compose up -d
```

Set `CORE_URL` and the release version in `.env`. The default Compose file runs as a non-root account, drops all Linux capabilities, enables `no-new-privileges`, uses a read-only root filesystem, limits processes, memory, and CPU, and persists `/var/lib/makerspace-printer-connector` in a named volume. It needs outbound access to Core and to configured printers. No ports are published.

The enrollment file can be removed after the first successful enrollment; persistent identity is stored in the data volume. Back up that volume as sensitive data. Restoring two running containers from the same volume is prevented on one host by the process lock, but operators must also avoid cloning it to another host.

The healthcheck reads a local health timestamp. A stale check reports unhealthy without deleting the durable queue. Docker health status alone does not restart containers; the `unless-stopped` restart policy handles process exits.

## Reliable event delivery

SQLite runs in WAL mode with full synchronous writes and contains monotonically increasing per-assignment sequences plus a durable outbox. An adapter observation is acknowledged to the adapter only after the event commits locally. The queue survives container and network restarts and is capped at 100,000 events; reaching the cap stops adapter ingestion with an explicit degraded state instead of dropping data.

The connector sends at most 20 events per request. Network failures and transient per-event receipts use bounded exponential backoff. An event is deleted locally only after Core returns `accepted` or `duplicate`. Permanent rejections move it to the quarantine count for operator diagnosis.

Core validates connector ownership, assignment ownership, configuration version, event size, event kind, UUID, sequence, and timestamps. It keys idempotency by the connector event UUID and independently protects each assignment sequence. Reusing an event UUID or sequence with different facts is rejected. Events from an ended assignment, an old configuration, or an incomplete run history are retained for review and do not update an Attempt automatically.

The connector protocol starts at version 1. Core and connector report their protocol and software versions in configuration and heartbeat payloads. Additive fields can be deployed independently; a connector rejects an unsupported protocol rather than silently interpreting it.

## Local simulator workflow

For local HTTP development, build the connector image and set:

```text
CORE_URL=http://host.docker.internal:8080
CONNECTOR_ALLOW_HTTP=true
```

After creating `printer-connector/secrets/printer-connector-enrollment`, run the isolated development Compose project with:

```sh
docker compose -f printer-connector/compose.development.yaml up --build
```

Create an enabled printer profile in Core, assign it to the connector, and select one of the simulator scenarios:

- `idle` sends online and idle state.
- `successful_print` sends progress, successful completion, and estimated consumption.
- `failed_print` sends progress, failure, and estimated consumption.

The interval is configurable from 1 to 3600 seconds. These scenarios use the same SQLite outbox, HTTP authentication, Core event ingress, observed-run correlation, and consumption approval paths as future manufacturer adapters.

## Operations

The container writes structured JSON logs to standard output. Logs contain connector and assignment identifiers and error types, without tokens, printer secrets, payload bodies, or unnecessary personal data.

Use the administration diagnostics panel to compare the applied and desired configuration revisions, inspect assignment runtime states, enable, disable, or end assignments, view queue and quarantine counts. Connectors can be disabled without destroying their identity and enabled again later. Disablement advances the configuration revision and sends an empty assignment snapshot so a reachable connector stops its printer supervisors. A heartbeat older than 90 seconds is displayed as disconnected even when the last reported state was connected.

Configuration is a complete snapshot polled every 30 seconds. The last encrypted snapshot remains active during Core outages. A changed revision cancels the current adapter contexts, applies the new snapshot, and starts fresh supervisors. Graceful shutdown cancels adapters, checkpoints SQLite, and releases the data-directory lock.

