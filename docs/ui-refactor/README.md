# UI/UX refactoring — approved execution plan

Approved 2026-10-11. This directory is the persistent coordination source for the complete Carbon v11 UI refactor. See [architecture](architecture.md), [navigation](navigation.md), [deletion matrix](deletion-matrix.md), [work packages](work-packages.md), and [progress](progress.md).

## Goals and decisions

Unify navigation, Events (overview, modal creation, every detail panel and public-flow presentation), mobile Open Days, and the entire Machine Logbook (catalog, printer profiles/submissions, jobs/review, inventory/spools, configuration/statistics). Preserve existing workflows, registered permissions, API contracts, transaction/audit semantics, branding and routes. Do not redesign Dashboard. Existing printer-connector development receives compatibility checks only.

The owner approved four navigation groups; mobile Open Days defaults to an agenda with optional calendar; Open Day periods remain hard-deletable in **every** lifecycle state with full cascade confirmation. Only existing APIs/lifecycles are used. New purge, retention, archive, discarded detection or topology-edit models are deferred. No backend endpoints, permissions or migrations are introduced.

Use Astra for orchestration/review and directly assigned `gpt-5.6-sol` workers (medium ordinarily, high for authorization/state complexity). Maximum four concurrent agents including orchestrator. No custom configuration is necessary. Continue ready packages automatically, respecting explicit file ownership. No pushes or pull requests.

## Existing working tree

The starting branch is `main`, with 44 modified tracked files and printer-connector additions (102 status entries). These are pre-existing user changes, particularly API/generated code, App routing, Settings, permissions, backend and CI. Do not reset, overwrite or stage unrelated changes. A diagnostic pre-refactor diff/status snapshot is in `/private/tmp/makerspace-ui-refactor-preexisting` for this session only; it is not a recoverable commit or part of the repository.

## Acceptance

Carbon components/tokens, keyboard/focus behavior and permission-aware controls; no private browser-storage cache. Phone and desktop workflows must remain complete. Initial recursively imported JS <=225000 gzip bytes; entry CSS <=80000 gzip bytes. Preserve chart lazy loading, selective Sass, immutable hashed assets, non-cached HTML, gzip, missing-asset 404 and disabled production source maps.

## Deferred policy work

Financial snapshot anonymization/retention; draft survey deletion; obsolete session policy lifecycle; provider/connector purge; abandoned print-submission lifecycle; automatic job dismissal; printer input-unit/slot edit/delete. Do not represent Person deletion as erasing retained financial recipient snapshots.
