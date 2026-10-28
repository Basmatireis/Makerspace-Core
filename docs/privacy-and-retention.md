# Privacy registry, retention and data-subject requests

The privacy registry is the core module that records which personal data the makerspace stores, which module owns it, and how long the installation has handled it. This document covers the declared inventory, its persisted snapshot, the privacy settings and the read API, and the retention policy engine: versioned policies, holds, runs and dry runs, and the scheduler that executes them. Data-subject requests follow in the next phase and will use the same holds and runs.

## Overview

- **What it is.** Every built-in module declares its data categories in code, in `backend/internal/privacycatalog`. The registry validates these declarations, persists a snapshot of them, and shows them in Settings › Data › Privacy & data retention (tabs Overview, Data categories and Settings).
- **Core module.** Privacy is a core module, so it can never be disabled. A category stays registered after its owning module is disabled or its plugin is removed, so later retention and data-subject requests still reach that data.
- **Retention.** The retention engine (`backend/internal/privacy`) applies approved retention policies to the categories that have a retention routine. It runs from `admin cleanup` (legacy mode, manually or from the deployment's scheduler), from the dry run and execute buttons, and from the API scheduler when automatic runs are enabled. Until a category has an active policy, its legacy period applies unchanged.
- **Data-subject requests.** Not yet answered by the engine; they follow in the next phase.

The registry is implemented in `backend/internal/privacy`; the declarations and the legacy defaults live in `backend/internal/privacycatalog`.

## Data categories

### Declaration fields

Each category (`privacy.Definition`) declares:

- `id`: a stable dotted identifier, for example `events.external_signups`;
- owner module, name and description;
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

- `TestCatalogIsValid` checks every declaration's shape against the module catalog, and that no category is declared twice.
- `TestEveryPersonalDataColumnBelongsToACategory` proves that every known personal-data column and every foreign key to people belongs to exactly one category, and that no field is claimed twice.
- `TestLegacyDefaultsMatchTheRoutinesTheyReplace` checks each legacy default against the routine it describes.

Adding a column that holds personal data without declaring it fails the build's tests.

## Registry status

- **Snapshots.** On first use after a start, the registry writes every declared category to `privacy_category_snapshots` (migration `00080`), with its owner module and definition.
- **Orphaned categories.** A snapshot whose category is no longer declared by any module is marked `orphaned` and stays visible, with its stored description. Orphaned data is still in scope for later retention and data-subject requests.
- **Disabled modules.** A category whose owner module is disabled stays listed with `ownerModuleEnabled: false`. The Overview lists the disabled owner modules.

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

## Holds

A hold stops retention from acting on data:

- a **category hold** skips the whole category in every run; its run items carry the status `skipped_hold`;
- a **person hold** blocks erasure of that person. Data-subject requests use it in the next phase.

Holds are created with `POST /privacy/holds` and ended with `POST /privacy/holds/{holdId}/release`, both with `privacy.policies.manage`. They are audited as `privacy.hold_created` and `privacy.hold_released`.

## Runs and dry runs

A run executes the handlers of the active policies in one of two modes:

- **`dry_run`** executes the same handlers inside a transaction that is rolled back. It reports what would change and changes nothing.
- **`execute`** applies the handlers. Each category is processed in batches of 500 rows, at most 20 batches per category per run, each batch in its own short transaction.

A run records its trigger (`manual`, `scheduled` or `cli`) and one item per category with its action, affected count and status. Items carry counts only, never records. Runs are audited as `privacy.retention_run_dry_run` or `privacy.retention_run_execute`, with counts only.

Start a run with `POST /privacy/retention/runs` (`privacy.retention.execute`); list runs with `GET /privacy/retention/runs` and read one with `GET /privacy/retention/runs/{runId}`. The UI offers the same as the Dry run and Execute buttons in the tab Execution history.

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
| `GET /privacy/overview` | `privacy.read` | Counts of categories, orphaned categories, disabled owner modules and the automatic-runs flag. |
| `GET /privacy/categories` | `privacy.read` | Declared and orphaned categories with their status. |
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

`privacy.read`, `privacy.settings.manage`, `privacy.policies.manage` and `privacy.retention.execute` are not granted to existing roles. `master` receives them through the registry. `privacy.settings.manage`, `privacy.policies.manage` and `privacy.retention.execute` are part of the master fresh-sign-in policy (10 minutes). See [Authorization](authorization.md).

## Legal note

The registry and its templates are aids for the operator. They are neither legal advice nor a guarantee of compliance. The operator decides the purposes, legal bases and retention periods of the makerspace, and records them in the deployment's operating record (see [Operations](operations.md#cleanup-and-retention)).
