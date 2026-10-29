# Privacy registry, retention and data-subject requests

The privacy registry records which personal data the makerspace stores, which feature area owns it, and how long the installation has handled it. This document covers the declared inventory, its persisted snapshot, the privacy settings and the read API, the retention policy engine (versioned policies, holds, runs and dry runs, and the scheduler that executes them), and data-subject requests (access exports and erasure) with the record of processing activities.

## Overview

- **What it is.** Every built-in feature area (called the owner module of a category) declares its data categories in code, in `backend/internal/privacycatalog`. The registry validates these declarations, persists a snapshot of them, and shows them in Settings › Data › Privacy & data retention. The categories page is the entry of the privacy area; retention policies, holds, execution history, data requests, processing activities and settings are its sub-pages, reached from the context line under the summary tiles and from the rows themselves.
- **Always on.** The registry has no switch. A category stays registered after the code that declared it is gone, so later retention and data-subject requests still reach that data.
- **Retention.** The retention engine (`backend/internal/privacy`) applies approved retention policies to the categories that have a retention routine. It runs from `admin cleanup` (legacy mode, manually or from the deployment's scheduler), from the dry run and execute buttons, and from the API scheduler when automatic runs are enabled. Until a category has an active policy, its legacy period applies unchanged.
- **Data-subject requests.** Access and erasure requests walk through a manual identity check, an assessment, an approval and the execution; each category answers through its subject handler. See [Data-subject requests](#data-subject-requests).

The registry is implemented in `backend/internal/privacy`; the declarations and the legacy defaults live in `backend/internal/privacycatalog`.

## Data categories

### Declaration fields

Each category (`privacy.Definition`) declares:

- `id`: a stable dotted identifier, for example `events.external_signups`;
- owner module, name and description;
- `contains`: in plain words what the category holds ("first and last name, e-mail, matriculation number"), for operators who do not know the schema;
- `erasure`: what a data-subject erasure does to the rows (`erased`, `unlinked`, `retained_legal`, `manual_review`; `none` for categories without a subject);
- `fields`: the columns that hold the data as `table.column`;
- `triggers`: the events that start a retention period (`created_at`, `completed_at`, `cancelled_at`, `expired_at`, `account_closed_at`, `last_used_at`, `legal_period_end`, `ended_at`);
- `actions`: what retention may do (`delete`, `anonymize`, `unlink`, `redact`, `retain_with_review`). `retain_with_review` is a reviewed exception, never silent indefinite retention;
- `subject`: whether rows are linked to a `person`, an `account`, or `none`;
- `legacy`: where one existed, the period, action and source the installation used before the registry (for example `AUDIT_RETENTION`, `EVENT_SIGNUP_RETENTION`, a code constant of `admin cleanup`, the timelapse setting, or a lazy sweep on read);
- an optional retention note explaining limits.

### Categories

The table lists every built-in category. Legacy defaults are the behaviour that existed before the registry; a period of 0 under `admin cleanup` means the data is removed as soon as it has expired.

| Id | Name | Owner module | Subject | Legacy default |
| --- | --- | --- | --- | --- |
| `people.identity` | Person records | `identity` | person | none |
| `accounts.credentials` | Account credentials | `identity` | account | none |
| `auth.sessions` | Sessions and sign-in state | `identity` | account | expired, 0 (`admin cleanup`) |
| `auth.pending_state` | Pending sign-in and enrollment state | `identity` | account | none |
| `scim.mappings` | SCIM provisioning mappings | `identity` | person | none |
| `attendance.visits` | Visits and holds | `attendance` | person | completed, 90 days, anonymize (`admin cleanup`) |
| `surveys.invitations` | Survey invitations | `attendance` | person | expired, 7 days, unlink (`admin cleanup`) |
| `surveys.responses` | Survey responses | `attendance` | person | none |
| `events.external_signups` | External event sign-ups | `events` | person | completed, 180 days, redact (`EVENT_SIGNUP_RETENTION`) |
| `events.content` | Event planning content | `events` | person | none |
| `opendays.assignments` | Open day assignments | `open_days` | person | none |
| `trainings.records` | Training records | `trainings` | person | none |
| `laborordnung.requests` | Lab Rules confirmations | `laborordnung` | person | none |
| `audit.events` | Audit events | `platform` | account | created, 365 days, delete (`AUDIT_RETENTION`) |
| `orders.financial_records` | Financial records | `orders` | person | none |
| `orders.idempotency` | Idempotency evidence | `orders` | account | none |
| `organizations.contacts` | Organization contacts | `machines` | person | none |
| `machinelogbook.jobs` | Machine jobs and runs | `machines` | person | none |
| `machinelogbook.inventory` | Inventory ledger notes | `machines` | none | none |
| `printing.artifacts` | Print files and previews | `machines` | none | none |
| `printing.telemetry` | Printer telemetry | `machines` | none | created, 30 days, delete (lazy prune of connector activity) |
| `runrecordings.timelapses` | Run timelapses | `machines` | none | created, 90 days, delete (timelapse setting) |
| `inbox.notifications` | In-app notifications | `platform` | account | created, 90 days, delete (lazy sweep on read) |
| `signage.announcements` | Signage announcements | `signage` | none | ended, 30 days, delete (lazy sweep on read) |
| `devices.credentials` | Device and service credentials | `platform` | none | none |
| `platform.actor_references` | Actor references | `platform` | account | none |
| `files.blobs` | Stored files | `platform` | none | none |
| `configuration.contacts` | Configured contact addresses | `platform` | none | none |

### Inventory tests

The inventory is enforced by tests in `backend/internal/privacycatalog/catalog_test.go`:

- `TestCatalogIsValid` checks every declaration's shape and that no category is declared twice.
- `TestEveryPersonalDataColumnBelongsToACategory` proves that every known personal-data column and every foreign key to people belongs to exactly one category, and that no field is claimed twice.
- `TestLegacyDefaultsMatchTheRoutinesTheyReplace` checks each legacy default against the routine it describes.

Adding a column that holds personal data without declaring it fails the build's tests.

## Registry status

- **Snapshots.** On first use after a start, the registry writes every declared category to `privacy_category_snapshots` (migration `00080`), with its owner module and definition.
- **Orphaned categories.** A snapshot whose category is no longer declared in code is marked `orphaned` and stays visible, with its stored description. Orphaned data is still in scope for later retention and data-subject requests.

### Coverage

Each category carries what the registry knows beyond its declaration, so the categories page answers "is this covered?" without opening the other pages: `coverage.policyStatus` is `active` when a policy is in force, `pending` when only a draft or approved version exists (the previous behaviour still applies), and `none` without any version; `coverage.policy` is that version; `coverage.hold` the open category hold; `coverage.lastRun` the most recent run item of the category (mode, trigger, action, affected rows, status); `coverage.processingActivities` the activities of the record of processing that name the category. The search above the categories table matches the name, description, what it contains, the field names, the area of the app and the "Belongs to" label (for example "A person").

## Settings

The installation's privacy settings are stored in `privacy_settings` (a single row):

- `controllerName` and `controllerAddress`: the controller named in the privacy notice;
- `dataProtectionContact`: who answers data protection questions;
- `automaticRunsEnabled`: whether the API scheduler runs active retention policies on its own. It defaults to **off**. While it is off, the scheduler runs only the legacy routines described in [Scheduler and legacy behaviour](#scheduler-and-legacy-behaviour), and `admin cleanup` from the deployment's scheduler remains the production path for the other categories;
- `runIntervalMinutes`: how often the scheduler runs active policies while automatic runs are on, from 5 to 1440 minutes (default 60);
- `version`: an optimistic version that every update must send as `expectedVersion`.

Changes are audited as `privacy.settings_updated` with the names of the changed fields, not their values.

## Retention policies

A retention policy is a versioned decision for one data category: its trigger (for example `created_at` or `completed_at`), period in days, action, purpose, legal basis and reason. Each version moves through the lifecycle **draft → approved → active → retired**.

- **Seeded drafts.** The first read seeds one draft per category from its legacy default (`sourceTemplate: legacy:<source>`). Drafts are not in force until they are approved and activated.
- **Opt-out.** A configured opt-out (`AUDIT_RETENTION=0`, `EVENT_SIGNUP_RETENTION=0`, or a timelapse retention of 0) is seeded as `retain_with_review`, with the reason to confirm.
- **Editing.** Only drafts can be edited (`PUT /privacy/policies/{policyId}`; 409 `policy_not_draft` otherwise). To change an approved or active decision, create a new draft.
- **Approval.** Approval requires purpose, legal basis and reason (409 `policy_incomplete` otherwise).
- **Four eyes.** The person who approved a version cannot activate it (409 `policy_four_eyes`). Masters are excepted.
- **Activation.** Exactly one version per category is active. Activating a version retires the previous active one.
- **Audit.** Each step is audited as `privacy.policy_created`, `privacy.policy_updated`, `privacy.policy_approved`, `privacy.policy_activated` or `privacy.policy_retired`, with the changed field names only.

Policies are managed with `privacy.policies.manage`: `GET|POST /privacy/policies`, `PUT /privacy/policies/{policyId}` and `POST /privacy/policies/{policyId}/transition` with `{status}`.

In the web interface a decision is edited on its category: "Edit retention" in a row of the categories page opens `/settings/privacy/categories/{categoryId}`, where the rule is asked in three questions (when the clock starts, how long the data is kept, what happens then), followed by purpose, legal basis and reason. Saving creates or updates the category's draft; the page shows the decision in force, what the draft would mean, the three steps to get it into force with the approve and activate buttons, the version history and the last run of the category. A dry run from that page applies the decision in force to that category only. There is no separate policies table.

## Holds

A hold stops retention from acting on data:

- a **category hold** skips the whole category in every run; its run items carry the status `skipped_hold`;
- a **person hold** blocks erasure of that person: an erasure request is refused with 409 `erasure_on_hold` while one is open.

The holds table search matches the scope (category name and description, or the person), the reason, the creator and whether the hold is open or released.

Holds are created with `POST /privacy/holds` and ended with `POST /privacy/holds/{holdId}/release`, both with `privacy.policies.manage`. They are audited as `privacy.hold_created` and `privacy.hold_released`.

## Runs and dry runs

A run executes the handlers of the active policies in one of two modes:

- **`dry_run`** executes the same handlers inside a transaction that is rolled back. It reports what would change and changes nothing.
- **`execute`** applies the handlers. Each category is processed in batches of 500 rows, at most 20 batches per category per run, each batch in its own short transaction.

A run records its trigger (`manual`, `scheduled` or `cli`) and one item per category with its action, affected count and status. Items carry counts only, never records. Runs are audited as `privacy.retention_run_dry_run` or `privacy.retention_run_execute`, with counts only.

Start a run with `POST /privacy/retention/runs` (`privacy.retention.execute`); list runs with `GET /privacy/retention/runs` and read one with `GET /privacy/retention/runs/{runId}`. The UI offers the same as the Dry run and Execute buttons on the Execution history page.

Categories without a retention handler are reported with the status `skipped_no_handler`.

## Scheduler and legacy behaviour

The API process runs its periodic jobs through one scheduler (`backend/internal/platform/scheduler`):

- `runrecordings.maintenance` every five minutes: expires stale connector commands and deletes queued file blobs;
- `surveys.delivery` every `SURVEY_DELIVERY_INTERVAL` (`0` disables it);
- `privacy.retention`, described below.

Each run takes a PostgreSQL transaction-scoped advisory lock (`pg_try_advisory_xact_lock`). A replica that finds the lock taken skips the run, so several API replicas never run the same job at once. Scheduler logs carry counts only.

**While `automaticRunsEnabled` is off (the default),** the `privacy.retention` job runs only the routines that already ran automatically inside the API before, with their legacy periods:

- timelapses, by the recording setting;
- in-app notifications, 90 days;
- signage announcements, 30 days;
- printer telemetry, 30 days.

`admin cleanup` from the deployment's scheduler stays the production path for sessions, audit events, attendance visits, survey invitations and external event sign-ups.

**When `automaticRunsEnabled` is on,** active policies run every `runIntervalMinutes`, and a category with an active policy is governed by that policy. No category is handled twice in one run.

Lazy sweeps are removed: in-app notifications and signage announcements are no longer pruned on reads. The scheduled job prunes them instead.

### Handled categories

Every category below has a retention handler that applies its action inside the caller's transaction, in batches. The former cleanup queries are reused unchanged.

| Category | Legacy period | Legacy source |
| --- | --- | --- |
| `auth.sessions` | Expired or revoked sessions, no grace period | `admin cleanup` |
| `auth.pending_state` | Pending sign-in, passkey challenge, OIDC flow and kiosk enrollment context state (new handler, no legacy period) | Engine |
| `surveys.invitations` | Seven days after expiry; delivery identity is unlinked | `admin cleanup` |
| `attendance.visits` | 90 days after completion; completed visits roll up into daily statistics first; open visits are never removed | `admin cleanup` |
| `audit.events` | 365 days (`8760h`) | `AUDIT_RETENTION`, `--audit-before` |
| `events.external_signups` | 180 days after completion or cancellation; contact snapshot and management-token digest are erased | `EVENT_SIGNUP_RETENTION` |
| `inbox.notifications` | 90 days | Scheduler (formerly lazy sweep on read) |
| `signage.announcements` | 30 days after the end | Scheduler (formerly lazy sweep on read) |
| `printing.telemetry` | 30 days; connector activity and unreferenced printer events | Scheduler (formerly lazy prune) |
| `printing.artifacts` | New handler: 3MF files and previews not used by a running run are removed; runs and jobs keep their records with the link cleared | No legacy period |
| `runrecordings.timelapses` | 90 days (`timelapse_retention_days`; `0` keeps them) | Recording settings |

## Data-subject requests

A data-subject request (`backend/internal/subjectrequests`) answers a person's request for access to their data or for erasure. The request record holds the operator's reference, the channel, dates, counts and outcomes per category, and the lifecycle steps with their actors; it never holds the exported data itself.

### Lifecycle

**received → identity_verified → assessed → approved → executing → completed | partially_completed**, or **rejected** from any open state.

- **Received.** The request is recorded with the person, the channel (`email`, `in_person`, `letter`, `other`), the date it was received and the operator's own reference (a ticket number, never the subject's name). The statutory deadline (`dueAt`, one month after receipt) is derived.
- **Identity verified.** A manual step: the operator records how the identity was checked (the note says *how*, for example "student card shown in person", never what document was copied).
- **Assessed.** Every category's subject handler runs inside a transaction that is rolled back. The assessment stores the number of records per category, for an erasure the outcome each category would have, the blockers that would stop the deletion (such as `person_scim_managed` or `accounts_delete_required`), the number of open holds on the person, and the person-linked categories without a handler. It can be repeated.
- **Approved.** The person who verified the identity cannot approve (409 `request_four_eyes`); masters are excepted.
- **Executed** (`privacy.requests.execute`). An **access** request builds one ZIP archive with `manifest.json` (controller, request, sections), one JSON document per category under `data/` and the profile image under `files/`, and stores it as a private file. An **erasure** runs the handlers again, then deletes the person through the people service with its usual rules (`people.delete` and, with an account, `accounts.delete` are required; SCIM provisioning and the last enabled master block it; an open person hold is refused with 409 `erasure_on_hold`). The request ends `completed`, or `partially_completed` when records were retained for a legal obligation, need manual review, or a category had no handler.
- **Rejected.** Closes the request with a reason.

The web interface lists requests under Settings › Data › Privacy & data retention › Data requests with the step each one is at, the next step and who may take it, and the due date; each request has its own page (`/settings/privacy/requests/{requestId}`) that shows the five steps, the current step with its single action and note, the assessment in plain words, the facts and the timeline. The API resolves the names of the person and of the actors on read (`personName`, `identityVerifiedByName`, `approvedByName`, `executedByName`, `steps[].actorName`); they are never stored in the request, so they disappear with the person. The requests table search matches the person, the reference, the channel, the kind (access or erasure), the status and its detail line with the actor names, and the next step.

Every step is audited as `privacy.subject_request_<status>`; execution as `privacy.subject_request_executed` with counts only; a download of the export as `privacy.subject_request_export_downloaded`.

### Subject handlers and outcomes

Each person- or account-linked category registers a `privacy.SubjectHandler` with `Export` (the category's records of the subject, as JSON, with explicit columns so that secrets never leave the database) and `Erase`. The built-in handlers rely on the person deletion: the database cascades or clears the links, so `Erase` counts the records and declares the outcome.

| Outcome | Meaning | Built-in categories |
| --- | --- | --- |
| `erased` | Deleted with the person | identity, credentials, sessions, pending state, visits, survey invitations, event sign-ups, open day assignments, training records, Lab Rules confirmations, organization memberships, notifications |
| `unlinked` | Kept without the person link | survey responses (anonymous results), event content, machine jobs and runs, actor references, privacy records |
| `retained_legal` | Kept for a legal obligation, link removed | financial records, idempotency evidence, audit events |
| `manual_review` | An operator must act first | SCIM mappings (deprovision in the identity provider) |

Print files and run timelapses are not person-linked; the export's manifest says so and they are referenced only through machine jobs.

### Processing activities

The record of processing activities (`privacy_processing_activities`) is the operator's own list: name, purpose, legal basis, the data categories it covers, recipients and a retention note. It is read with `privacy.read` and maintained with `privacy.settings.manage` (`/privacy/processing-activities*`), version-checked and audited as `privacy.processing_activity_created|updated|deleted`.

### Retention of requests

Closed requests and their export archives belong to the category `privacy.records`; its retention handler deletes closed requests whose completion lies before the cutoff and queues their archives for blob deletion. Open requests are never touched.

## Configuration transfer

The section `privacy` of the [configuration export and import](configuration-transfer.md) carries the controller settings, one retention decision per category and the record of processing activities. Imported decisions arrive as drafts and are approved and activated on the importing instance; holds, runs, data-subject requests and the automatic-runs switch never travel.

## admin cleanup

`admin cleanup` is the legacy mode of the retention engine. It uses the same queries and the same periods as before (`AUDIT_RETENTION`, `EVENT_SIGNUP_RETENTION` and the code constants), and records a run.

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report what would change; change nothing. |
| `--category <id>` | Limit the run to one data category. Repeatable. |
| `--audit-before <RFC 3339>` | One-off audit cutoff; overrides `AUDIT_RETENTION`, as before. |

The output lists the run, then one line per category with its action, affected count and status. The former four-counter line is gone.

## API and permissions

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `GET /privacy/overview` | `privacy.read` | Counts of categories, orphaned categories, categories with an active, a pending or no policy, open holds, the last run and the automatic-runs flag. |
| `GET /privacy/categories` | `privacy.read` | Declared and orphaned categories with their status and coverage: the decision of record (active, else approved, else newest draft), the open category hold, the last run item and the processing activities that name the category. |
| `GET /privacy/settings` | `privacy.read` | The privacy settings. |
| `PUT /privacy/settings` | `privacy.settings.manage` | Change the privacy settings with `expectedVersion`. |
| `GET /privacy/policies` | `privacy.policies.manage` | List retention policy versions. |
| `POST /privacy/policies` | `privacy.policies.manage` | Create a draft version for a category. |
| `PUT /privacy/policies/{policyId}` | `privacy.policies.manage` | Edit a draft. |
| `POST /privacy/policies/{policyId}/transition` | `privacy.policies.manage` | Approve, activate or retire a version (`{status}`). |
| `GET /privacy/holds` | `privacy.policies.manage` | List holds. |
| `POST /privacy/holds` | `privacy.policies.manage` | Place a category or person hold. |
| `POST /privacy/holds/{holdId}/release` | `privacy.policies.manage` | Release a hold. |
| `GET /privacy/retention/runs` | `privacy.retention.execute` | List retention runs. |
| `POST /privacy/retention/runs` | `privacy.retention.execute` | Start a `dry_run` or `execute` run. |
| `GET /privacy/retention/runs/{runId}` | `privacy.retention.execute` | Read a run with its per-category items. |
| `GET /privacy/processing-activities` | `privacy.read` | The record of processing activities. |
| `POST /privacy/processing-activities`, `PUT|DELETE /privacy/processing-activities/{activityId}` | `privacy.settings.manage` | Maintain the record, version-checked. |
| `GET|POST /privacy/requests`, `GET /privacy/requests/{requestId}` | `privacy.requests.manage` | Record and read data-subject requests. |
| `POST /privacy/requests/{requestId}/transition` | `privacy.requests.manage` | Verify the identity, assess, approve or reject (`{status, note, expectedVersion}`). |
| `POST /privacy/requests/{requestId}/execute` | `privacy.requests.execute` (+ `people.delete` for erasure) | Execute an approved request. |
| `GET /privacy/requests/{requestId}/export` | `privacy.requests.execute` | Download the export archive of a completed access request. |

`privacy.read`, `privacy.settings.manage`, `privacy.policies.manage`, `privacy.retention.execute`, `privacy.requests.manage` and `privacy.requests.execute` are not granted to existing roles. `master` receives them through the registry. All but `privacy.read` are part of the master fresh-sign-in policy (10 minutes). See [Authorization](authorization.md).

## Legal note

The registry and its templates are aids for the operator. They are neither legal advice nor a guarantee of compliance. The operator decides the purposes, legal bases and retention periods of the makerspace, and records them in the deployment's operating record (see [Operations](operations.md#cleanup-and-retention)).
