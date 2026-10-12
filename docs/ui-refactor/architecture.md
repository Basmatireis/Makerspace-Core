# Architecture and ownership

## Existing foundation

Reuse `frontend/src/app/PageShell.tsx`, `PageHeader.tsx` and `PageState.tsx`. Directory `UserDetailPage.tsx` and `PersonDetailComponents.tsx` are the detail-layout reference; put Carbon TabList inside PageShell.tabs. Carbon DataTable remains the desktop list; mobile uses domain-specific Carbon Tile/StructuredList layouts. No generic CRUD framework or new runtime dependency.

Shared additions: DetailSection/DetailRow, RowActions, DestructiveActionDialog, unsaved-changes guard, EmptyState. Preserve Carbon modal focus and cancellation, pending/error state and domain-specific consequences. Form close/discard uses one active dialog surface. Guard same-path tab changes as well as routes, Escape, Cancel, browser Back and beforeunload. Background query changes must not overwrite dirty drafts. Record exact helper interfaces below before feature integration.

## Styles and responsive contract

Phone breakpoint is Carbon md (42rem). Keep eager shell/common tokens/layout in styles/index.scss, move only feature-specific Events/OpenDays/Machine Logbook rules into owned lazy styles. Do not relocate all Carbon Sass or import heavy features through an eager shared barrel. Feature workers own separate feature styles after initial extraction. Shared index.scss edits are serialized through the foundation owner/integrator.

OpenDays `view=calendar|list` preserves `mode=edit` and unrelated query parameters. Absent explicit view: phone list/agenda, desktop calendar; explicit selection survives resize. Desktop list stays table, phone list is date-grouped agenda. Phone calendar day activation opens a spacious agenda; no dense edit/drag controls. Keep every filtering, recurrence, bulk edit, staffing and atomic working-copy behavior. Use one dialog layer for detail/assign/confirm and two-step recurrence input/review.

Events: `/events/new` route-backed modal over overview; preserve list search/status/page/scroll/focus; direct entry closes to `/events`. Existing three inputs remain, owner stays Settings. Event detail tabs use `?tab=overview|schedule|planning|staffing|files|settings`, preserving other parameters. Split existing panels into feature files, retain every field/action and nuanced post-event mutability. Do not remount dirty Settings on event.version changes. Public routes keep public shells and privacy behavior.

Machines: add `/machine-logbook/machines/:machineId` using existing getMachine; keep `/:machineId/printer`. General detail/header plus conditional printer workflow, server search/filter/pagination, type editing and lifecycle actions. Only actual printer-profile 404 means absent; PUT uses latest expectedVersion when existing. Review selection is job ID, with successor selection and dirty protection. Material editing/deactivation, identifier delete, attempt cancel use existing clients.

Configuration: independent organizations.read and pricing.read panels; route/settings visibility accepts either. Organizations pricing selector additionally needs pricing.read and mutation pricing.manage. Machine-type lookup requires machines.read; without it show existing IDs and explain unavailable selector, while material pricing remains usable. Never assume manage implies read.

## Query ownership

Existing eventKeys and machineLogbookKeys remain. Integrator owns shared queries.ts changes, including getMachine and invalidation. Broad machineLogbookKeys.all invalidation can remain: it covers list/detail/type/profile, job/review, inventory/spools, printing reconciliation and overview/statistics. It must not reset dirty drafts. Lookup calls are gated with their actual read permissions; required unavailable selectors show a reason. Registration of spools needs filament_spools.manage AND inventory.manage; stock consumption/correction needs inventory.manage. Job links need machine_jobs.read.

## Shared file ownership

Foundation owner: app primitives, PersonDetailComponents extraction, styles/index.scss and initial feature stylesheet extraction.
Navigation owner: AppShell/AppNavigation, App navigation tests, Settings SPA links (preserve connector tile).
Integrator only: App.tsx routing, auth/permissions.ts, shared feature queries.ts, package manifests/build checks, docs/progress. Feature workers propose integration changes rather than editing these concurrently.
Feature workers own only package component paths, isolated styles and newly named tests. Existing broad test files are edited by the owning package sequentially or by integrator. Generated API/backend/migrations are outside implementation scope.

## Shared interfaces (AP01)

- `app/DetailSection.tsx`: DetailSection(title, description?, headingContent?, meta?, action?, className?, children); DetailRow(label, value: ReactNode, monospace?, action?). PersonDetailComponents re-exports these.
- `app/RowActions.tsx`: visible inline group `{label,children,className?}`; children are Carbon buttons/links, never a forced overflow menu.
- `app/DestructiveActionDialog.tsx`: `{open,title,children,confirmLabel,cancelLabel?,pending?,error?,onConfirm,onClose}`. Cancel focus; pending blocks duplicate submit/close.
- `app/useUnsavedChanges.ts`: `useUnsavedChanges({isDirty,onDiscard?})` returns requestDiscard(action), bypassAfterSubmit(action), dialogOpen, confirmDiscard, keepEditing. `app/UnsavedChangesDialog.tsx` exports UnsavedChangesDialog; it takes guard and optional title/message/confirmLabel/cancelLabel. Keep ONE active router guard per route. Main modal uses open={formOpen && !guard.dialogOpen}; render the discard dialog separately so there is one active surface. Confirmed discard/success must not block a second time or leave navigation permanently bypassed.
- `app/PageState.tsx`: EmptyState({title,description?,action?}).
- `app/useLatestCallback.ts`: stable event callback that reads the latest committed state. Carbon Modal captures Escape handlers when open changes; use this for close handlers that inspect dirty/pending state. Controlled ComposedModal onClose must also return false so its internal state does not hide a pending/discarded editor independently of the parent.
- DestructiveActionDialog accepts launcherButtonRef for disappearing overflow items and restores focus on actual unmount. Machine catalog/configuration forms use CatalogFormModal to retain launcher focus across a discard view.
- `machinelogbook/queries.ts`: machineQuery(id) and machineLogbookKeys.machine(id), integrated by lead using existing getMachine client.
- `features/auth/permissions.ts`: canLookupJobParties(user) mirrors the shared backend authorization for billing-party and operator searches: orders.read OR machine_jobs.create OR machine_jobs.review OR organizations.read. Job read/edit and print-submission manage alone do not authorize these lookups.
- `useUnsavedChanges` optionally accepts shouldBlockNavigation(currentLocation,nextLocation). Editors whose view/mode URL changes preserve the draft may allow those changes while guarding real exits; beforeunload and explicit discard requests still protect dirty work.

## Production budget command

`pnpm build` now emits a Vite manifest and runs `pnpm check:bundle`. The dependency-free checker recursively walks static imports (not dynamic imports), sums per-file gzip sizes and fails above 225000 JS/80000 CSS bytes. Run `node scripts/check-bundle-budget.mjs <build-directory>` for an isolated diagnostic build. No runtime package added.
