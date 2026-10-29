# Makerspace Printer Connector

The Makerspace Printer Connector is a single Go process that runs inside a printer network and makes outbound HTTPS requests to Makerspace Core. One instance can supervise multiple printers and adapter kinds. It does not expose an inbound application port, require host networking, or need device access.

The connector includes the deterministic simulator plus the `bambu_h2d` and `bambu_x1c` LAN adapters. Both Bambu adapters are observational: they receive status, retrieve the archive for an observed print when available, and report facts to Core. They never upload a print to the printer or start, pause, resume, or cancel physical motion.

## Domain boundaries

Core remains authoritative for Machines, printer profiles, input units, slots, spool assignments, machine runs, Machine Jobs, pricing, inventory, and audit history. A connector assignment binds one enabled printer profile to one connector and one adapter configuration. The active-assignment database constraint prevents two connectors from controlling the same profile.

A **recorded run** is a physical printer job reported by a connector. Staff see it as a run of a job (display ID `R-YYYY-NNNNNN`, see [Machine logbook](machine-logbook.md#jobs-and-runs)). Core derives the run's facts from the events a connector sends: `fileName` (up to 255 characters) from run-start and progress payloads, `percent` (0-100) and `remainingSeconds` from progress payloads (giving progress and estimated end), start and end from event times and the terminal outcome, and itemized reported consumption. Missing or invalid keys are ignored. Replayed events never change a run.

A detected print always creates or resumes a run and may remain unassigned. After its 3MF is accepted, Core automatically attaches it only when the archive SHA-256 uniquely matches a same-machine planned job with no runs. Zero or multiple matches remain unassigned for staff reconciliation, and automatic matching never replaces a manual assignment. Creating a planned job from an existing artifact is an authenticated Core operation; it creates no run and sends nothing to the printer. An unmatched physical print never creates an ownerless Machine Job.

Printer slot observations are assignment/topology facts rather than run lifecycle events. The reducer emits one only when stable slot identity data changes, so changing temperatures, progress, stages, and remaining-percent telemetry do not flood a run's event history. By default they remain observational. An assignment may opt into exact-RFID spool mounting as described below; administrators still resolve unknown or conflicting evidence in the existing printer profile and inventory screens.

## Enrollment and credentials

Connector identities are separate from people, browser sessions, and Managed Devices. The database stores SHA-256 digests of enrollment and runtime tokens. Printer adapter secrets use the configured Core application encryption key and never appear in administration responses.

1. Give the operator `printer_connectors.read`, `printer_connectors.manage`, and `printer_connectors.credentials.manage` as appropriate. Assigning a printer also requires `machines.manage`; attaching a run to a job requires `machine_jobs.edit`.
2. In **Settings → Local services → Printer connectors**, create a connector and choose **Enroll**.
3. Copy the one-time 43-character secret into `CONNECTOR_ENROLLMENT_SECRET` in the stack's `.env`. The secret expires after 15 minutes and is displayed once.
4. Start the connector. It generates its runtime credential locally, exchanges the enrollment secret, encrypts the resulting identity in its data volume, and begins polling configuration. From then on the variable is ignored (the connector logs that once) and can be removed. Without an identity and without a secret it exits with instructions. `CONNECTOR_ENROLLMENT_SECRET_FILE` (a path) is still honoured as a legacy fallback when the variable is empty.

Runtime credentials expire after 90 days. The connector rotates its own credential during the final seven days. Core accepts the prior credential for a 24-hour handover window so a successful server response followed by a local disk failure can recover safely. Revocation immediately rejects all credentials, invalidates open enrollment, ends assignments, and is audited.

To connect a daemon to a different or newly created connector or gateway, put the new enrollment secret into `CONNECTOR_ENROLLMENT_SECRET` and restart. If the secret differs from the one used for the stored identity, the daemon enrolls with it and replaces its local identity. If Core rejects the new secret, the daemon keeps running with the old identity and logs an error. An unchanged secret is ignored and can be removed. If the log says "Core rejects this connector's credential (revoked or deleted)", the connector was revoked or deleted: create a new connector (or use a pending one), put its secret into `.env` and restart.

**Deleting a connector.** `DELETE /printer-connectors/{id}` (`printer_connectors.manage`, `expectedVersion`) works in every lifecycle, including revoked. In one transaction Core revokes the credentials and open enrollments, resolves open printer errors, marks runs that were still running as `unknown`, and deletes the assignments (with their live statuses), enrollments, credentials, discovery requests and the events no run or usage rests on. Recorded runs, printer error history and the events behind runs and usage stay; they only lose the reference to the connector and the assignment (migration 00055). The action is audited as `printer_connector.deleted` without secrets. A connector daemon that still runs with the deleted credential gets 401 and stops; its printers can be assigned to another connector. A new enrollment secret (`POST /printer-connectors/{id}/enrollments`, `printer_connectors.credentials.manage`) can be issued for pending, active and disabled connectors (revoked ones answer 409 `printer_connector_revoked`); issuing one invalidates an earlier unused secret and is audited (`printer_connector.enrollment_issued`).

**Re-enrolling an enrolled connector.** To move a connector to another host or recover after losing its data volume without losing its printer assignments, issue a new enrollment secret for it (Settings, Local services, Printer connectors, row menu, New enrollment secret). Issuing does not touch the current credential: the running connector keeps working until the new secret is used. When a daemon enrolls with it, Core in one transaction makes the new credential current, revokes every earlier credential of the connector, bumps the configuration revision so the new daemon pulls its configuration, and audits `printer_connector.reenrolled` (no secrets). The connector keeps its id, assignments and lifecycle (a disabled connector stays disabled). The old daemon, if it still runs, gets 401 and logs that Core rejects its credential. Put the secret into `CONNECTOR_ENROLLMENT_SECRET` on the new host (or the same host after deleting the volume) and start.

All production Core URLs must use HTTPS. Plain HTTP is accepted only when `CONNECTOR_ALLOW_HTTP=true`, which is intended for an isolated local development stack.

## Bambu Lab H2D and X1 Carbon setup

V1 requires an H2D or X1 Carbon on a trusted local network with its firmware's Developer/LAN-only access enabled. Record the printer's IPv4 address, uppercase serial number, and LAN access code. Reserve the IPv4 address in DHCP or configure it consistently; discovery is not part of V1. Create or edit the assignment in the printer setup, select the matching Bambu model, choose the connector, and enter those values. Leaving the LAN-code field blank while editing preserves the encrypted credential; entering a non-empty value rotates it. **Automatically mount spools identified by exact Bambu RFID** is opt-in and should be enabled only after the printer profile's AMS input-unit and tray external IDs are configured.

The connector makes outbound connections directly to the configured printer IP on MQTT `8883` and implicit FTPS `990`. Docker Desktop must be able to route from its Linux VM to that LAN address. `host.docker.internal` is for reaching the Docker host and is not a substitute for the printer IP. Check VPN routing, guest-network isolation, and host firewall policy when the host can reach the printer but the container cannot. No inbound port, host networking, cloud account, or multicast discovery is required.

MQTT uses QoS 1 on `device/{serial}/report`. Connection loss is isolated to the assignment and retried with cancellable jittered exponential backoff from one second to one minute. On an initial connection or reconnect the connector sends one rate-limited `pushing.pushall` information request to obtain a full snapshot; it is not a printer-control loop. This is the information-request behavior documented by the [OpenBambuAPI MQTT reference](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md). Differential objects merge recursively, arrays replace as units, JSON `null` clears a value, and lifecycle decisions wait for a usable snapshot. A missing snapshot degrades that assignment after 15 seconds without making the connector process unhealthy.

TLS on MQTT and both FTPS channels validates the full chain and validity period against Bambu's [`printer.cer` from Bambu Studio](https://github.com/bambulab/BambuStudio/blob/master/resources/cert/printer.cer), with retrieval attribution in the connector source. The leaf certificate Common Name must equal the configured serial even though the network connection uses an IP address. Unknown authorities, expired or incomplete chains, and serial mismatches fail closed; there is no verification-bypass setting.

FTPS searches only `/cache` and `/` after telemetry supplies an explicit `.3mf` candidate filename. It uses an exact path first and then an exact basename. A reported `/data/Metadata/plate_N.gcode` is an internal member of the active archive, not an FTPS archive path; when no archive path is reported, both reviewed models expose the exact print name plus `.gcode.3mf`. No fuzzy match is used. The intentionally narrow client follows the passive-mode and delayed data-channel TLS behavior recorded by [open-bamboo-networking's FTPS research](https://github.com/ClusterM/open-bamboo-networking/blob/master/research/06.03-ftps.md). Ambiguous names, unstable sizes, corrupt ZIPs, and unavailable external storage are deferred rather than guessed. Telemetry continues while artifact retrieval or upload retries independently, and the diagnostics UI keeps fresh MQTT values marked live while showing any artifact-only delay separately. Staged archives and the artifact-transfer queue live in the connector's protected named volume; reaching the queue cap degrades only the assignment and does not delete unacknowledged data.

The connector calculates inventory consumption only after a terminal outcome. Successful prints use complete per-filament slicer weights (`slicer_complete`). Failed or unknown outcomes select the latest G-code layer checkpoint supported by the last reliable MQTT layer, convert parsed extrusion using density/diameter or slicer length/weight normalization, and report model, purge/loading, and unclassified quantities when the markers support that split (`gcode_checkpoint`). It publishes an unresolved line when no defensible conversion or unique G-code stream exists; it never multiplies full-file weight by MQTT percentage. Calculation version, method, and quality are immutable. While a run is active, its page may show a clearly labeled display-only `~used / planned` estimate after Core has parsed the retrieved 3MF; this multiplies planned grams by printer progress for operator awareness and never changes stock. The archive may upload while printing, but its private staged copy is retained after Core acknowledges it until the terminal consumption event is durably queued; only then is that copy removed.

Stable diagnostic categories distinguish configuration, TLS trust/expiry/serial mismatch, MQTT authentication/connectivity, FTPS authentication/listing/retrieval, unsupported model, missing snapshot, and artifact backlog. Logs never include the LAN code, MQTT payload bodies, archive contents, or private filenames.

## Run reports, commands and timelapses

A Core that supports them announces `recordings` (`timelapseEnabled`, `timelapseMaxBytes`) in every configuration response. A connector uses the endpoints below only while the latest configuration carries that field, so newer connectors work with older Core and older connectors with newer Core (protocol version stays 1; all additions are optional). The field is read on every 10-second configuration poll, also when the revision did not change.

### Run reports (why consumption is missing)

`PUT /printer-connector/self/assignments/{assignmentId}/runs/{runId}/report` (`PrinterConnectorRunReport`) carries the connector's newest facts per run in two optional sections, each `{state, reason, detail}`, with codes matching `^[a-z][a-z0-9_]{0,79}$`:

- `consumption`: `pending` (still retrying), `reported` (a consumption event was queued; `reason` names the cause of unresolved lines) or `unavailable` (the connector gave up). Reasons: `artifact_not_found_on_printer` (detail `artifact_not_available`, `artifact_ambiguous`, `artifact_candidate_not_archive`, `artifact_retry_expired` or `no_archive_reported` when the printer never named a 3MF), `artifact_on_internal_storage` (the print was started from the printer's internal storage, which the connector cannot read; detail = the printer's internal path as a code, `/data/Metadata/plate_1.gcode` becomes `data_metadata_plate_1_gcode`; reported as `pending` while the run is still running and as `unavailable` when the lookup after the run found nothing; see [storage detection](#storage-detection-of-a-bambu-print)), `artifact_retrieval_failed` (detail = FTPS/TLS diagnostic, for example `ftps_listing_failed`), `artifact_upload_failed` (detail = transport diagnostic), `artifact_rejected` (Core answered 422; detail = Core's code, the transfer is quarantined), `no_slicer_weights_in_artifact`, `gcode_estimate_unavailable`, `cancelled_before_first_layer` (failed/unknown outcome with no layer and no progress), `consumption_pending` (archive staged, calculation waits for the outcome).
- `timelapse`: `pending`, `uploaded`, `not_found`, `failed`, `skipped` with reasons `timelapse_not_recorded`, `timelapse_ambiguous`, `timelapse_baseline_missing`, `timelapse_too_large`, `timelapse_retrieval_failed`, `timelapse_upload_failed`, `timelapse_disabled`.

The connector keeps one row per run in its SQLite `run_reports` table with a revision; a changed section bumps the revision and the delivery loop (every 2 seconds, 20 reports per pass) sends it. 404 and 422 answers drop the report; other failures retry after 30 seconds. Reports older than 30 days are pruned. Core stores the newest observation per section in `machine_run_connector_reports` (migration 00078) without auditing; an older `observedAt` never replaces a newer one. Core derives each recorded run's `consumptionStatus` from these reports and its own facts, see [Machine logbook](machine-logbook.md#consumption-status-files-and-timelapses).

### Storage detection of a Bambu print

The connector reads only external storage (USB or SD card) over FTPS. It treats a print's 3MF as reachable only when a status message of the current session (the per-run fact `reportedUrl`, never the merged document) carried a `url` that points at external media (`file:///media/usb…`, `file:///mnt/sdcard…`, `file:///sdcard…`, or any `ftp(s)://` url, since everything the printer serves over FTP is external storage) and whose file name, without `.gcode.3mf` or `.3mf`, equals the print's `subtask_name` (case-insensitive). An archive name the printer reports explicitly in `file`, `filename` or `gcode_file` (ending in `.3mf`) also counts as external. When the run saw no `url` at all (a connector started during the print, or run facts written by an older connector), the merged document's `url` counts if its file name matches the print; a previous print's url does not. Otherwise the run's `source` is `internal_storage` (`classifyBambuPrintSource`, `bambu_storage.go`; persisted as optional `source`, `reportedUrl`, `internalPath` and `archiveCandidate` run facts, so older state files stay valid).

For an internal-storage print the connector reports `consumption` `pending`/`artifact_on_internal_storage` as soon as the run is classified, and at the same time schedules one retrieval that looks the archive up by the print name on external storage (`archiveCandidate`, the print name plus `.gcode.3mf`) while the print is still running: a USB print whose `url` did not match (an older status, a renamed file) is then fetched during the print like any other archive, so preview, estimate and consumption arrive before the end. The lookup is scheduled once per run (further progress reports do not queue it again); a run whose retrieval was already scheduled or that has no archive candidate is left alone. If external storage was listed and the file is not there, the report becomes `unavailable`/`artifact_on_internal_storage` and nothing is retried; a failing listing is retried like any transport failure. The lookup after the terminal outcome remains as a fallback for runs recorded before this behaviour or whose candidate only became known at the end.

Observed on H2D: during a local print from internal storage the status carried `gcode_file` and `file` = `/data/Metadata/plate_1.gcode`, `subtask_name` = `Sticky Notes Holder.stl + Sticky Notes Holder.stl + Sticky Notes Holder.stl` and `print_type` `local`, but no new `url`. The merged document still held `url` = `file:///media/usb0/cache/FlipOff_Ghostie.stl.gcode.3mf` from the previous USB print, so `url` is not refreshed for internal-storage prints and is only evidence when it arrived in the current session and names the current print. Observed on X1C: a print sent to the SD card over the network reports `url` = `ftp://<print name>.gcode.3mf` (no host or directory), also with `gcode_file` = `/data/Metadata/plate_1.gcode` and `print_type` `local`, so neither of those fields tells the storage apart. Core ignores an `artifact_on_internal_storage` report for a run whose 3MF it already holds.

### Commands

Staff can ask the connector that recorded a run to re-fetch the 3MF from the printer or to recompute the run's consumption (see the machine logbook). Core keeps the commands in `machine_run_commands`. The connector polls `GET /printer-connector/self/commands` every 10 seconds (this also sets `printer_connectors.commands_polled_at`; Core refuses new commands with 409 `connector_commands_unavailable` when the connector has not polled within five minutes) and stores each command once in its SQLite `run_commands` table. It reports `running`, `succeeded` or `failed` (with `reasonCode`) with `PUT /printer-connector/self/commands/{commandId}/status`; allowed transitions are requested to running/succeeded/failed and running to succeeded/failed, repeats are idempotent and anything else answers 409 `command_finished` (the connector then stops reporting it).

- `refetch_artifact` makes the run's archive retrieval pending again (attempts reset, 30-minute window) with the archive path the printer reported. It succeeds once the archive is staged and acknowledged by Core and fails with `artifact_not_found_on_printer` (`artifact_on_internal_storage` for a print from internal storage, where the lookup by print name is made once and not retried) or `artifact_retrieval_failed` when the retrieval gives up, or `artifact_path_unknown` when the printer never reported an archive for the run. For an internal-storage print the command is still accepted: it looks the archive up by print name on external storage.
- `recompute_consumption` needs the reducer's run facts (kept for the last 64 sessions; otherwise `run_facts_unavailable`). It downloads the stored 3MF with `GET /printer-connector/self/assignments/{assignmentId}/runs/{runId}/artifact/content` (verified against `X-Artifact-SHA256`, at most 512 MiB; failure `artifact_download_failed`), stages it as already acknowledged (it is not uploaded again), forgets the run's earlier calculation markers and lets the adapter calculate again with the next report revision (`consumption_revisions`). Core replaces the machine's earlier report without double counting; staff corrections stay authoritative. It succeeds once the new consumption event is queued.
- Commands for assignments that are not running in this connector fail with `assignment_not_running`, for the simulator with `adapter_unsupported`.

Command polling, execution and timelapse uploads run in their own loop (every 5 seconds), so long transfers never delay events, live status or heartbeats. Core fails commands that were not started within 15 minutes (`command_expired`) or run longer than an hour (`command_timed_out`).

### Timelapse videos

When the recording settings enable timelapses, the Bambu adapters retrieve the printer's timelapse video of each print over the same verified FTPS connection (read-only `LIST`/`RETR`, now also below `/timelapse`). Bambu writes the video below `/timelapse` only when the timelapse option was enabled for the print. Its file name (for example `video_2026-10-27_09-00-00.mp4`) carries the printer's local time without a time zone, so it is never used for matching. The rules:

1. **Baseline.** When the connector first sees a run active (`PREPARE`, `RUNNING` or `PAUSE`), it lists `/timelapse` and stores every file name with its size. A missing `/timelapse` directory (FTP 550) is an empty baseline. A failing listing is retried every 20 seconds while the print runs.
2. **Search.** After the terminal outcome the connector lists `/timelapse` again and accepts exactly one plain file (`^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.mp4$`, case-insensitive extension, size above 0) that is new since the baseline or larger than in it, and that no other run of the assignment already claimed. Thumbnails, directories and other files are ignored.
3. **Stable size.** The file is retrieved only when two listings at least 15 seconds apart report the same name and size.
4. **Giving up.** No candidate within 15 minutes after the end: `not_found`/`timelapse_not_recorded`. Two or more candidates: `not_found`/`timelapse_ambiguous` at once. A run that ended without a baseline (the connector started during the print, or the baseline listing never succeeded): `not_found`/`timelapse_baseline_missing`. A file above `timelapseMaxBytes`: `failed`/`timelapse_too_large`. Twenty failed retrievals: `failed`/`timelapse_retrieval_failed` (detail = diagnostic). Disabled collection: `skipped`/`timelapse_disabled`. Timelapse problems are recorded per run and never degrade the assignment's health; there is no manual retry.
5. **Upload.** The video is streamed to a staging file in the data volume (`timelapses/`, mode 0600, SHA-256 computed while writing) and then streamed to `PUT /printer-connector/self/assignments/{assignmentId}/runs/{runId}/timelapse` with `X-Timelapse-Filename`, `X-Timelapse-SHA256` and `Content-Length` (one upload at a time, up to one hour per request). Neither side holds the video in memory: Core streams the body into private file storage, verifying length, SHA-256 and the MP4 `ftyp` signature, and opens its database transaction only after the blob is stored. 201 and 200 (same bytes again) complete the upload; 409 `run_timelapse_exists` means Core keeps another video; 409 `timelapse_disabled`, 413 `timelapse_too_large`, 404 and 422 give up; other failures retry with backoff up to 20 times. The staged file is deleted afterwards in every case.

Core's limit is `PRINTER_TIMELAPSE_MAX_BYTES` (default 2 GiB, 1 MiB to 8 GiB). Retention, downloads and deletion are described in the [machine logbook](machine-logbook.md#consumption-status-files-and-timelapses).

**Unverified on real printers:** where and when X1C and H2D create the video file (at print start or after encoding at the end; the growth rule covers a file created at the start), its exact naming, whether `/timelapse` is reachable over LAN-only FTPS on every firmware, and FTP reply codes for a missing directory. The rules above were exercised with a scripted FTPS fake only.

When Core holds the run's 3MF (staff uploaded it, see [Machine logbook](machine-logbook.md#upload-a-3mf-afterwards)), an internal-storage run is not given up: after the run's terminal outcome, and again before the one-shot lookup gives up, the connector downloads the stored file from `GET /printer-connector/self/assignments/{a}/runs/{r}/artifact/content` (404 means Core has none), stages it as already acknowledged and calculates the consumption from it like for a retrieved file. A file uploaded after the run ended arrives as a `recompute_consumption` command instead. A failed download only leaves the run without a 3MF.


## Docker deployment

Release images use this name:

```text
ghcr.io/basmatireis/makerspace-core-printer-connector:<version>
```

Setup, the variables (`MAKERSPACE_VERSION`, `CORE_URL`, `CONNECTOR_ENROLLMENT_SECRET`), enrollment, upgrades and backups for the production bundle and for development (`make dev-connector`) are described in [Hosting](hosting.md#stack-2-printer-connector-makerspace-connector). The Compose file runs as a non-root account, drops all Linux capabilities, enables `no-new-privileges`, uses a read-only root filesystem, limits processes, memory, and CPU, and persists `/var/lib/makerspace-printer-connector` in a named volume. It needs outbound access to Core and to configured printers. No ports are published.

Back up the data volume as sensitive data. Restoring two running containers from the same volume is prevented on one host by the process lock, but operators must also avoid cloning it to another host.

The healthcheck reads a local health timestamp. A stale check reports unhealthy without deleting the durable queue. Docker health status alone does not restart containers; the `unless-stopped` restart policy handles process exits.

Back up the connector volume together with Core's PostgreSQL database, private file storage, and encryption configuration. The connector volume contains encrypted assignment state, durable event/artifact queues, and temporary private archives. Restore it only to one connector instance. A printer or Core outage is recoverable by leaving the volume intact and restarting the same configuration; do not clear SQLite or staged files to resolve connectivity errors.

## Reliable event delivery

SQLite runs in WAL mode with full synchronous writes and contains monotonically increasing per-assignment sequences plus a durable outbox. An adapter observation is acknowledged to the adapter only after the event commits locally. The queue survives container and network restarts and is capped at 100,000 events; reaching the cap stops adapter ingestion with an explicit degraded state instead of dropping data.

The connector sends at most 20 events per request. Network failures and transient per-event receipts use bounded exponential backoff. An event is deleted locally only after Core returns `accepted` or `duplicate`. Permanent rejections move it to the quarantine count for operator diagnosis.

Core validates connector ownership, assignment ownership, configuration version, event size, event kind, UUID, sequence, and timestamps. It keys idempotency by the connector event UUID and independently protects each assignment sequence. Reusing an event UUID or sequence with different facts is rejected. Events from an ended assignment, an old configuration, or an incomplete run history are retained for review and do not update a run automatically.

The connector protocol starts at version 1. Core and connector report their protocol and software versions in configuration and heartbeat payloads. Additive fields can be deployed independently; a connector rejects an unsupported protocol rather than silently interpreting it.

Bambu lifecycle identity uses the strongest non-zero tuple of LAN task, task, job, and subtask identifiers. The observed local task identifier remains untrusted; filenames corroborate a session but never identify it. When no stable identifier exists, a persisted lifecycle generation is allocated on an inactive-to-active transition. `PREPARE`, `RUNNING`, and `PAUSE` establish or resume a run; pause/resume facts are transition-only. `FINISH` succeeds, `FAILED` fails unless a future verified fixture supplies explicit cancellation evidence, and 100 percent progress alone never terminates a run. A terminal snapshot retained at connector startup does not create historical work. A session that disappears without trustworthy terminal evidence closes as unknown. If MQTT remains disconnected for five minutes during an active run, the connector also closes that run as unknown. The disconnect timestamp is persisted, so restarting the connector does not reset the grace period. A late active snapshot for that same timed-out session does not reopen the run; a later trustworthy terminal snapshot may refine its final state.

AMS reports do not make printer-reported material, color, remaining weight, or `tray_uuid` authoritative. When exact-RFID auto-detection is disabled, all observations remain read-only. When enabled, Core may create a `connector_reconciled` slot assignment only when the observation identifies an exact configured input-unit/tray pair and its verified `tag_uid` uniquely identifies an active, non-empty Core spool. It never creates spools or identifiers, never replaces a staff/manual assignment, and never acts on material/color similarity. A later exact observation may move only a prior connector-reconciled mount. Two consecutive observations without an RFID tag produce a confirmed-empty transition; that transition closes only a connector-reconciled mount and never a manual assignment. Consumption resolves the historical slot assignment and exact NFC evidence at the report timestamp; disagreement remains unresolved. H2D retains distinct tray evidence per physical extruder. X1C interprets `ams.tray_now` as global index `unit*4+tray` and records its ordered changes through physical extruder 1. For several materials changed through one nozzle, the connector uses the archive's first-use filament sequence and the observed tray-change order only when the complete run history and counts agree exactly. Ambiguous or incomplete mappings remain unresolved; the final tray is never copied onto every line of a multi-material report.

## Live status

Besides events, an adapter may report the printer's current state as a **live status snapshot**. This is telemetry, not history: the connector keeps only the newest snapshot per assignment in memory and sends it with `PUT /printer-connector/self/assignments/{assignmentId}/status` (`PrinterLiveStatusReport`: protocol version, configuration version, observation time, snapshot). It is not part of the SQLite outbox, is never retried as history, and does not survive a restart.

- **Delivery.** A changed snapshot is sent at most once every 5 seconds. An unchanged snapshot is repeated every 60 seconds while the assignment is connected, which refreshes Core's `receivedAt`; nothing is sent while the printer is disconnected. A failed request is retried with the then newest snapshot. A `404` or `409` answer (ended assignment, changed configuration version) discards the snapshot; the restarted adapter reports a fresh one.
- **Core.** Core keeps exactly one row per assignment in `printer_live_statuses`, does not audit it and never overwrites a newer observation with an older one. The compact snapshot is limited to 32 KiB (the table caps the stored JSON at 64 KiB). Only fields named in the `PrinterLiveStatusSnapshot` schema are stored; unknown fields are dropped. `GET /machines/{machineId}/printer/live-status` returns the snapshot of the machine's active assignment (`machines.read`) or `404`.
- **Content.** State (`idle`, `preparing`, `printing`, `paused`, `finished`, `failed`, `unknown`), the current job (file name, percent, layer, total layers, remaining minutes), extruder, bed and chamber temperatures, nozzles, spool units with trays (material, sub-brand, `RRGGBB` color, remaining percent, RFID present, empty), the active tray, active errors, firmware version and Wi-Fi signal in dBm. It never contains IP or MAC addresses, serial numbers, camera or RTSP data, or other network identifiers. Every key is always present; unknown values are `null`.
- **Simulator.** The simulator adapter reports a fixed plausible snapshot (one AMS with two spools, an external holder, one nozzle) so the whole path can be exercised without a printer.

### H2D mapping

The snapshot is built from the merged status document. Fields that are not observed stay `null`.

| Snapshot          | H2D field                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`           | `gcode_state` (`IDLE`, `PREPARE`, `RUNNING`, `PAUSE`, `FINISH`, `FAILED`; anything else is `unknown`)                                                           |
| `job`             | `subtask_name` (else the base name of `gcode_file`), `mc_percent`, `layer_num`, `total_layer_num`, `mc_remaining_time` (minutes). `null` while idle or unknown. |
| temperatures      | `device.extruder.info[]` (`id`, `temp`, `htar`), `bed_temper`, `bed_target_temper`, `device.ctc.info.temp` (chamber)                                            |
| `nozzles`         | `device.nozzle.info[]` (`id`, `diameter`, `type`)                                                                                                               |
| `units`           | `ams.ams[]` (`id`, `humidity_raw` percent, `temp`, `tray[]`) and `vir_slot[]`                                                                                   |
| tray              | `tray_type`, `tray_sub_brands`, `tray_color` (RRGGBBAA, reported as RRGGBB), `remain` (percent; -1 and 0 mean unknown), `tag_uid` (all-zero means no RFID)      |
| `activeTray`      | `ams.tray_now`, only while a job is preparing, printing or paused                                                                                               |
| `errors`          | `print_error` (family `print`) and `hms[].code` (family `hms`); `observedAt` is when this process first saw the code                                            |
| `wifiSignalDbm`   | `wifi_signal`, for example `-39dBm`                                                                                                                             |
| `firmwareVersion` | not observed in the captured reports, always `null`                                                                                                             |

Unit kinds: AMS IDs below 128 are `ams`, IDs from 128 are `ams_ht`, and `vir_slot` entries are `external`. A tray is `empty` when `tray_exist_bits` (bit `unit index * 4 + tray`, AMS HT 128 is unit index 4) marks it absent and it reports no material; without that bitmask, when it reports neither material nor RFID.

### X1 Carbon mapping

X1C uses the same lifecycle, AMS, error, artifact, and Wi-Fi fields. Its classic single-nozzle status fields are `nozzle_temper`, `nozzle_target_temper`, `nozzle_diameter`, `nozzle_type`, and `chamber_temper`; they normalize as physical extruder `1` with no left/right side. `ams.tray_now` is a global tray number (`unit*4+tray`), so `0` through `3` are AMS unit `0` trays `0` through `3`. The reviewed external holder is `vir_slot` `255`, but X1C also emits `tray_now=255` for no selected tray while retaining the holder's descriptive material fields. V1 therefore keeps that holder observational and does not use `255` as run spool evidence without a future verified active-feed signal. All-zero `tag_uid` values mean no readable RFID and are never treated as identifiers. Bambu's X1 G-code commands `T1000`, `T1100`, and `T255` are calibration/unload commands, not materials or extruders. The X1 parser fixes all extrusion to physical extruder `1` and uses `M620`/`M621` for material changes.

### External spool holders (`vir_slot`)

`vir_slot[]` entries are reported as units of kind `external`. The unit external ID and its single slot external ID are both the `vir_slot` ID. H2D reports holders `254` and `255`; the reviewed X1C fixture reports holder `255`. External holders also produce `slot_observation` events, so exact-RFID auto-mount works for tagged external spools like for AMS trays, and a trustworthy active-holder report may become consumption evidence for a run.

### Assumptions to verify on a real printer

- **Extruder side.** Extruder `0` is reported as the `right` nozzle and extruder `1` as the `left` one. The mapping lives in one function (`bambuExtruderSide`) and is exposed as `side` on nozzles and extruder temperatures.
- **AMS to nozzle.** The protocol does not say which nozzle an AMS feeds, so detection reports units without a nozzle; staff choose it in the printer setup.
- **AMS HT `tray_now`.** A bare `tray_now` of 128 or more is treated as the single tray of the AMS HT unit with that ID. Other bare tray numbers that repeat across units stay unresolved.
- **`humidity_raw`** is the humidity percentage; `humidity` is a coarse level and is not used.

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

Sanitize a whitespace-separated JSON stream or NDJSON MQTT capture before review or replay. Each message may be a raw report object or an object with a JSON object/string in `payload`. The output path must not already exist and is created with mode `0600`. The sanitizer caps input and output at 50 MiB, normalizes timestamps, replaces stable identifiers consistently, and removes access codes, network identity, user fields, and private filenames.

```sh
go run ./cmd/printer-connector sanitize-mqtt \
  --input /protected/private/h2d-raw.ndjson \
  --output /protected/review/h2d-sanitized.ndjson
go run ./cmd/printer-connector replay-mqtt \
  --input /protected/review/h2d-sanitized.ndjson \
  --adapter bambu_h2d

go run ./cmd/printer-connector replay-mqtt \
  --input /protected/review/x1c-sanitized.ndjson \
  --adapter bambu_x1c
```

Replay accepts only the versioned sanitized format and drives the production reducer without opening SQLite or making network calls. Its NDJSON output contains normalized observations but omits generated run UUID values. Review sanitized output manually before committing it: automatic redaction is a defense, not authorization to publish customer data. Raw capture is disabled by default and this release provides no live-capture command. Real logs and 3MFs remain private, gitignored inputs unless an owner explicitly authorizes a reviewed derivative.

Synthetic fixtures exercise archive limits, parser variations, reducer transitions, and diagnostics in CI. Private X1C captures supplied during development replayed 1,089 multicolor MQTT messages into one run, one ordered tray change (`0/2` to `0/0`), and one successful terminal outcome; a private X1C 3MF parsed two used PLA lines at 2.28 g and 0.74 g. Those private files are not committed and CI does not reproduce that evidence. X1C TLS/authentication, live subscription, `pushall`, FTPS download, and disconnect recovery remain hardware-unverified until an actual X1C assignment is tested through the connector. No mechanical command is sent by these checks.

## Local simulator workflow

For local development next to `make dev`, run `make dev-connector` (stop with `make dev-connector-down`, logs with `make dev-connector-logs`). The target wraps `printer-connector/compose.development.yaml`, which sets `CORE_URL=http://host.docker.internal:8080` and `CONNECTOR_ALLOW_HTTP=true`, and guides you through the first enrollment; see [Hosting](hosting.md#printer-connector-in-development). Run it from the repository root; from another directory pass the repository explicitly, for example `make -C /path/to/Makerspace-core dev-connector`.

Create an enabled printer profile in Core, assign it to the connector, and select one of the simulator scenarios:

- `idle` sends online and idle state.
- `successful_print` sends progress, successful completion, and estimated consumption.
- `failed_print` sends progress, failure, and estimated consumption.

The interval is configurable from 1 to 3600 seconds. These scenarios use the same SQLite outbox, HTTP authentication, Core event ingress, run correlation, and machine-reported consumption paths as future manufacturer adapters.

## Operations

The container writes structured JSON logs to standard output. Logs contain connector and assignment identifiers and error types, without tokens, printer secrets, payload bodies, or unnecessary personal data.

Use the administration diagnostics panel to compare the applied and desired configuration revisions, inspect assignment runtime states, enable, disable, or end assignments, view queue and quarantine counts. Connectors can be disabled without destroying their identity and enabled again later. Disablement advances the configuration revision and sends an empty assignment snapshot so a reachable connector stops its printer supervisors. A heartbeat older than 90 seconds is displayed as disconnected even when the last reported state was connected.

Configuration is a complete snapshot polled every 10 seconds, and the heartbeat is sent every 10 seconds. The heartbeat answer carries Core's current configuration revision; when it is newer than the applied one, the connector fetches the configuration immediately instead of waiting for the next poll, so a new assignment or a changed printer setup takes effect within seconds. The last encrypted snapshot remains active during Core outages. A changed revision cancels the current adapter contexts, applies the new snapshot, and starts fresh supervisors. Graceful shutdown cancels adapters, checkpoints SQLite, and releases the data-directory lock.

## Clearing events

`POST /printer-connectors/{id}/events/clear` (`printer_connectors.manage`) sets `eventsClearedAt` (migration 00044) and audits `printer_connector.events_cleared`. The event list omits events received up to that time unless `includeCleared=true`. Events are never deleted.

**Where in the UI.** Connectors are managed under **Settings > Local services** (tab **Printer connectors**, next to the streaming gateways; route `/settings/local-services?tab=connectors`). Users with `printer_connectors.read` reach the page and its settings tile even without `local_services.manage`; they see only the connector tabs. The former Machines tab (`/machine-logbook/machines?tab=connectors`) and `/settings/printer-connectors` redirect there. The tab **Versions and updates** compares each connector's version with Core's and requests updates (see [Hosting](hosting.md#updating-stacks-2-to-4-from-the-web-ui-optional-updater)).

**Activity log.** What a connector changes on its own is not audited: received events, spool mounts and unmounts from RFID evidence, and the recorded runs and jobs that its events settle (outcome, material usage, inventory, price). Core writes one row per change into `printer_connector_activity` (migration 00062) in the transaction of the change, with identifiers only (connector, machine, the event, slot, run or job, the event kind and the changed field names; no personal data). Every heartbeat prunes the connector's entries older than 30 days and beyond the newest 10000. `GET /printer-connectors/{id}/activity?page=&pageSize=` (`printer_connectors.read`, newest first, at most 100 per page) lists them; the diagnostics dialog shows them on its **Activity log** tab. Staff actions on connectors, assignments, enrollments, credentials, manual spool mounts and printer setup stay in the audit log. Migration 00062 moved the runtime rows of the last 30 days out of the audit log into the activity log and deleted the older ones.
