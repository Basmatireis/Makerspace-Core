# Makerspace Printer Connector

The Makerspace Printer Connector is a single Go process that runs inside a printer network and makes outbound HTTPS requests to Makerspace Core. One instance can supervise multiple printers and adapter kinds. It does not expose an inbound application port, require host networking, or need device access.

The connector includes the deterministic simulator and the `bambu_h2d` LAN adapter. Other printer families remain outside this release. The H2D adapter is observational: it receives status, retrieves the archive for the observed print when available, and reports facts to Core. It never uploads a print to the printer or starts, pauses, resumes, or cancels physical motion.

## Domain boundaries

Core remains authoritative for Machines, printer profiles, input units, slots, spool assignments, machine runs, Machine Jobs, pricing, inventory, and audit history. A connector assignment binds one enabled printer profile to one connector and one adapter configuration. The active-assignment database constraint prevents two connectors from controlling the same profile.

A **recorded run** is a physical printer job reported by a connector. Staff see it as a run of a job (display ID `R-YYYY-NNNNNN`, see [Machine logbook](machine-logbook.md#jobs-and-runs)). Core derives the run's facts from the events a connector sends: `fileName` (up to 255 characters) from run-start and progress payloads, `percent` (0-100) and `remainingSeconds` from progress payloads (giving progress and estimated end), start and end from event times and the terminal outcome, and itemized reported consumption. Missing or invalid keys are ignored. Replayed events never change a run.

A detected print always creates or resumes a run and may remain unassigned. After its 3MF is accepted, Core automatically attaches it only when the archive SHA-256 uniquely matches a same-machine planned job with no runs. Zero or multiple matches remain unassigned for staff reconciliation, and automatic matching never replaces a manual assignment. Creating a planned job from an existing artifact is an authenticated Core operation; it creates no run and sends nothing to the printer. An unmatched physical print never creates an ownerless Machine Job.

Printer slot observations are assignment/topology facts rather than run lifecycle events. The reducer emits one only when stable slot identity data changes, so changing temperatures, progress, stages, and remaining-percent telemetry do not flood a run's event history. By default they remain observational. An assignment may opt into exact-RFID spool mounting as described below; administrators still resolve unknown or conflicting evidence in the existing printer profile and inventory screens.

## Enrollment and credentials

Connector identities are separate from people, browser sessions, and Managed Devices. The database stores SHA-256 digests of enrollment and runtime tokens. Printer adapter secrets use the configured Core application encryption key and never appear in administration responses.

1. Give the operator `printer_connectors.read`, `printer_connectors.manage`, and `printer_connectors.credentials.manage` as appropriate. Assigning a printer also requires `machines.manage`; attaching a run to a job requires `machine_jobs.edit`.
2. In **Settings → Printer connectors**, create a connector and choose **Enroll**.
3. Copy the one-time 43-character secret into the deployment's secret file. The secret expires after 15 minutes and is displayed once.
4. Start the connector. It generates its runtime credential locally, exchanges the enrollment secret, encrypts the resulting identity in its data volume, and begins polling configuration.

Runtime credentials expire after 90 days. The connector rotates its own credential during the final seven days. Core accepts the prior credential for a 24-hour handover window so a successful server response followed by a local disk failure can recover safely. Revocation immediately rejects all credentials, invalidates open enrollment, ends assignments, and is audited.

All production Core URLs must use HTTPS. Plain HTTP is accepted only when `CONNECTOR_ALLOW_HTTP=true`, which is intended for an isolated local development stack.

## Bambu Lab H2D setup

V1 requires an H2D on a trusted local network with its firmware's Developer/LAN-only access enabled. Record the printer's IPv4 address, uppercase serial number, and LAN access code. Reserve the IPv4 address in DHCP or configure it consistently; discovery is not part of V1. Create or edit the assignment in **Settings → Printer connectors**, select **Bambu Lab H2D**, choose the enabled printer profile, and enter those values. Leaving the LAN-code field blank while editing preserves the encrypted credential; entering a non-empty value rotates it. **Automatically mount spools identified by exact Bambu RFID** is opt-in and should be enabled only after the printer profile's AMS input-unit and tray external IDs are configured.

The connector makes outbound connections directly to the configured printer IP on MQTT `8883` and implicit FTPS `990`. Docker Desktop must be able to route from its Linux VM to that LAN address. `host.docker.internal` is for reaching the Docker host and is not a substitute for the printer IP. Check VPN routing, guest-network isolation, and host firewall policy when the host can reach the printer but the container cannot. No inbound port, host networking, cloud account, or multicast discovery is required.

MQTT uses QoS 1 on `device/{serial}/report`. Connection loss is isolated to the assignment and retried with cancellable jittered exponential backoff from one second to one minute. On an initial connection or reconnect the connector sends one rate-limited `pushing.pushall` information request to obtain a full snapshot; it is not a printer-control loop. This is the information-request behavior documented by the [OpenBambuAPI MQTT reference](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md). Differential objects merge recursively, arrays replace as units, JSON `null` clears a value, and lifecycle decisions wait for a usable snapshot. A missing snapshot degrades that assignment after 15 seconds without making the connector process unhealthy.

TLS on MQTT and both FTPS channels validates the full chain and validity period against Bambu's [`printer.cer` from Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/cert/printer.cer), with retrieval attribution in the connector source. The leaf certificate Common Name must equal the configured serial even though the network connection uses an IP address. Unknown authorities, expired or incomplete chains, and serial mismatches fail closed; there is no verification-bypass setting.

FTPS searches only `/cache` and `/` after telemetry supplies a candidate filename. It uses an exact path first and then an exact basename. The intentionally narrow client follows the passive-mode and delayed data-channel TLS behavior recorded by [open-bamboo-networking's FTPS research](https://github.com/ClusterM/open-bamboo-networking/blob/master/research/06.03-ftps.md). Ambiguous names, unstable sizes, corrupt ZIPs, and unavailable external storage are deferred rather than guessed. Telemetry continues while artifact retrieval or upload retries independently. Staged archives and the artifact-transfer queue live in the connector's protected named volume; reaching the queue cap degrades only the assignment and does not delete unacknowledged data.

The connector calculates inventory consumption only after a terminal outcome. Successful prints use complete per-filament slicer weights (`slicer_complete`). Failed or unknown outcomes select the latest G-code layer checkpoint supported by the last reliable MQTT layer, convert parsed extrusion using density/diameter or slicer length/weight normalization, and report model, purge/loading, and unclassified quantities when the markers support that split (`gcode_checkpoint`). It publishes an unresolved line when no defensible conversion or unique G-code stream exists; it never multiplies full-file weight by MQTT percentage. Calculation version, method, and quality are immutable. While a run is active, its page may show a clearly labeled display-only `~used / planned` estimate after Core has parsed the retrieved 3MF; this multiplies planned grams by printer progress for operator awareness and never changes stock. The archive may upload while printing, but its private staged copy is retained after Core acknowledges it until the terminal consumption event is durably queued; only then is that copy removed.

Stable diagnostic categories distinguish configuration, TLS trust/expiry/serial mismatch, MQTT authentication/connectivity, FTPS authentication/listing/retrieval, unsupported model, missing snapshot, and artifact backlog. Logs never include the LAN code, MQTT payload bodies, archive contents, or private filenames.

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

Back up the connector volume together with Core's PostgreSQL database, private file storage, and encryption configuration. The connector volume contains encrypted assignment state, durable event/artifact queues, and temporary private archives. Restore it only to one connector instance. A printer or Core outage is recoverable by leaving the volume intact and restarting the same configuration; do not clear SQLite or staged files to resolve connectivity errors.

## Reliable event delivery

SQLite runs in WAL mode with full synchronous writes and contains monotonically increasing per-assignment sequences plus a durable outbox. An adapter observation is acknowledged to the adapter only after the event commits locally. The queue survives container and network restarts and is capped at 100,000 events; reaching the cap stops adapter ingestion with an explicit degraded state instead of dropping data.

The connector sends at most 20 events per request. Network failures and transient per-event receipts use bounded exponential backoff. An event is deleted locally only after Core returns `accepted` or `duplicate`. Permanent rejections move it to the quarantine count for operator diagnosis.

Core validates connector ownership, assignment ownership, configuration version, event size, event kind, UUID, sequence, and timestamps. It keys idempotency by the connector event UUID and independently protects each assignment sequence. Reusing an event UUID or sequence with different facts is rejected. Events from an ended assignment, an old configuration, or an incomplete run history are retained for review and do not update a run automatically.

The connector protocol starts at version 1. Core and connector report their protocol and software versions in configuration and heartbeat payloads. Additive fields can be deployed independently; a connector rejects an unsupported protocol rather than silently interpreting it.

H2D lifecycle identity uses the strongest non-zero tuple of LAN task, task, job, and subtask identifiers. The observed local task identifier remains untrusted until reviewed real fixtures demonstrate whole-job stability; filenames corroborate a session but never identify it. When no stable identifier exists, a persisted lifecycle generation is allocated on an inactive-to-active transition. `PREPARE`, `RUNNING`, and `PAUSE` establish or resume a run; pause/resume facts are transition-only. `FINISH` succeeds, `FAILED` fails unless a future verified fixture supplies explicit cancellation evidence, and 100 percent progress alone never terminates a run. A terminal snapshot retained at connector startup does not create historical work. A session that disappears without trustworthy terminal evidence closes as unknown.

AMS reports do not make printer-reported material, color, remaining weight, or `tray_uuid` authoritative. When exact-RFID auto-detection is disabled, all observations remain read-only. When enabled, Core may create a `connector_reconciled` slot assignment only when the observation identifies an exact configured input-unit/tray pair and its verified `tag_uid` uniquely identifies an active, non-empty Core spool. It never creates spools or identifiers, never replaces a staff/manual assignment, and never acts on material/color similarity. A later exact observation may move only a prior connector-reconciled mount. Two consecutive observations without an RFID tag produce a confirmed-empty transition; that transition closes only a connector-reconciled mount and never a manual assignment. Consumption resolves the historical slot assignment and exact NFC evidence at the report timestamp; disagreement remains unresolved. For a single-filament artifact, the connector carries the last unambiguous active unit/tray/tag into the terminal report. It does not apply the final tray to every line of a multi-material report.

## Offline artifact and fixture diagnostics

The production connector binary contains read-only offline commands. From a repository checkout, prefix each command with `cd backend && go run ./cmd/printer-connector`; in the connector image use `/app/printer-connector`. They do not need a Core URL, connector identity, database, or printer.

Inspect a local 3MF, including normalized metadata, safe preview summaries, parser warnings, and full-file G-code estimates:

```sh
go run ./cmd/printer-connector inspect-3mf --file /protected/input/example.3mf
```

Calculate an interrupted-print estimate from G-code. The optional artifact supplies filament density/diameter or slicer length/weight conversion data. A layer/progress boundary selects an actual parsed checkpoint; the tool never multiplies total weight by a percentage.

```sh
go run ./cmd/printer-connector calculate-consumption \
  --gcode /protected/input/plate_1.gcode \
  --artifact /protected/input/example.3mf \
  --last-layer 37 --last-progress 42
```

Sanitize an NDJSON MQTT capture before review or replay. Each input line may be a raw report object or an object with a JSON object/string in `payload`. The output path must not already exist and is created with mode `0600`. The sanitizer caps input and output at 50 MiB, normalizes timestamps, replaces stable identifiers consistently, and removes access codes, network identity, user fields, and private filenames.

```sh
go run ./cmd/printer-connector sanitize-mqtt \
  --input /protected/private/h2d-raw.ndjson \
  --output /protected/review/h2d-sanitized.ndjson
go run ./cmd/printer-connector replay-mqtt \
  --input /protected/review/h2d-sanitized.ndjson
```

Replay accepts only the versioned sanitized format and drives the production reducer without opening SQLite or making network calls. Its NDJSON output contains normalized observations but omits generated run UUID values. Review sanitized output manually before committing it: automatic redaction is a defense, not authorization to publish customer data. Raw capture is disabled by default and this release provides no live-capture command. Real logs and 3MFs remain private, gitignored inputs unless an owner explicitly authorizes a reviewed derivative.

Synthetic fixtures exercise archive limits, parser variations, reducer transitions, and diagnostics in unit tests. No authorized real H2D logs/3MFs were supplied for this implementation, so real-fixture reproduction—including the approximately 1.20 g failed-print case—is unavailable and must not be inferred from synthetic data. H2D TLS/authentication, subscription, `pushall`, FTPS listing/download, and disconnect recovery also remain hardware-unverified. Mechanical motion and multimaterial-change tests are outside the permitted live verification scope.

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

The interval is configurable from 1 to 3600 seconds. These scenarios use the same SQLite outbox, HTTP authentication, Core event ingress, run correlation, and machine-reported consumption paths as future manufacturer adapters.

## Operations

The container writes structured JSON logs to standard output. Logs contain connector and assignment identifiers and error types, without tokens, printer secrets, payload bodies, or unnecessary personal data.

Use the administration diagnostics panel to compare the applied and desired configuration revisions, inspect assignment runtime states, enable, disable, or end assignments, view queue and quarantine counts. Connectors can be disabled without destroying their identity and enabled again later. Disablement advances the configuration revision and sends an empty assignment snapshot so a reachable connector stops its printer supervisors. A heartbeat older than 90 seconds is displayed as disconnected even when the last reported state was connected.

Configuration is a complete snapshot polled every 30 seconds. The last encrypted snapshot remains active during Core outages. A changed revision cancels the current adapter contexts, applies the new snapshot, and starts fresh supervisors. Graceful shutdown cancels adapters, checkpoints SQLite, and releases the data-directory lock.

