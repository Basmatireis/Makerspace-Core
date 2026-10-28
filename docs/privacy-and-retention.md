# Privacy registry, retention and data-subject requests

The privacy registry is the core module that records which personal data the makerspace stores, which module owns it, and how long the installation has handled it. This document covers the first phase: the declared inventory, its persisted snapshot, the privacy settings and the read API. Retention policies, the retention engine and data-subject requests follow in later phases.

## Overview

- **What it is.** Every built-in module declares its data categories in code, in `backend/internal/privacycatalog`. The registry validates these declarations, persists a snapshot of them, and shows them in Settings › Data › Privacy & data retention (tabs Overview, Data categories and Settings).
- **Core module.** Privacy is a core module, so it can never be disabled. A category stays registered after its owning module is disabled or its plugin is removed, so later retention and data-subject requests still reach that data.
- **What it does not do yet.** This phase changes no retention behaviour. No data is deleted, anonymized or unlinked differently than before, and the registry does not yet run policies or answer data-subject requests. `admin cleanup` and the existing lazy sweeps keep doing what they did.

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
- `automaticRunsEnabled`: whether the API process runs approved retention policies on its own. It defaults to **off**. While it is off, `admin cleanup` from the deployment's scheduler remains the production path, and that stays true after this release;
- `runIntervalMinutes`: how often automatic runs would happen, from 5 to 1440 minutes (default 60);
- `version`: an optimistic version that every update must send as `expectedVersion`.

Changes are audited as `privacy.settings_updated` with the names of the changed fields, not their values.

## API and permissions

| Endpoint | Permission | Purpose |
| --- | --- | --- |
| `GET /privacy/overview` | `privacy.read` | Counts of categories, orphaned categories, disabled owner modules and the automatic-runs flag. |
| `GET /privacy/categories` | `privacy.read` | Declared and orphaned categories with their status. |
| `GET /privacy/settings` | `privacy.read` | The privacy settings. |
| `PUT /privacy/settings` | `privacy.settings.manage` | Change the privacy settings with `expectedVersion`. |

`privacy.read` and `privacy.settings.manage` are not granted to existing roles. `master` receives them through the registry. `privacy.settings.manage` is part of the master fresh-sign-in policy (10 minutes). See [Authorization](authorization.md).

## Legal note

The registry and its templates are aids for the operator. They are neither legal advice nor a guarantee of compliance. The operator decides the purposes, legal bases and retention periods of the makerspace, and records them in the deployment's operating record (see [Operations](operations.md#cleanup-and-retention)).
