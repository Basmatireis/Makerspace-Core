# Execution progress

## Baseline (before implementation)

2026-10-11: TypeScript `pnpm exec tsc -p tsconfig.app.json --noEmit --incremental false` passed. Existing mocked Playwright Events (4), Open Days (4), Machine Logbook (2) passed: 10 total. Vite production build passed, manifest recursion measured 200397 bytes initial JS gzip and 76662 bytes entry CSS gzip. Charts absent from initial graph. Existing mobile calendar probes at320/390 confirmed clipped labels/actions and toolbar/legend overlap despite zero page overflow. No backend integration or generation check was run during planning.

| Package | Status | Owner / notes |
|---|---|---|
| AP00 | Complete | Lead; approved decisions and baseline persisted |
| AP01 | Implemented; integration review pending | Shared/PageShell tests16/16, targeted lint/build passed; JS200383/CSS71473 gzip |
| AP02 | Implemented; integration review pending | AppNavigation 4/4, protected-routing22/22, mobile E2E1/1; tsc/lint passed |
| AP03 | Implemented; independent review in progress | Events10/10 unit,4/4 browser; review_shared_events |
| AP04 | Implemented; review fixes in progress | Six panels and lifecycle/dirty protection; review identified two staffing draft-loss cases |
| AP05 | In progress | finish_opendays took over partial implementation after Sol usage limit |
| AP06 | Implemented; independent review pending |18/18 unit,5/5 expanded browser flows including25 route checks; tsc/lint passed |
| AP07 | In progress | implement_machines; Jobs/review and existing correction APIs |
| AP08 | Pending | Inventory/spools |
| AP09 | Implemented; visual refinements and independent review | Independent config rights tested,24/24 config+permission tests and existing edit test pass;5/5 browser widths |
| AP10 | Implemented; independent review pending | 64 focused tests covered after selector fix; role-dialog browser/Axe/focus check passed |
| AP11 | Pending | Integration/acceptance |

## Validation and review log

Append actual commands, results, fixes and blocked checks as work progresses. Keep pre-existing printer connector work separate. No application package is complete merely because code was written.

- Lead added manifest-based production budget gate and getMachine query helper. Checker lint passed; baseline manifest reproduces 200397/76662 bytes.

- Backend `docker compose run --rm --no-deps backend go test ./...` passed. Real PostgreSQL tests were skipped in that run because TEST_DATABASE_URL was unset.
- PostgreSQL `TEST_DATABASE_URL="$DATABASE_URL" go test -count=1 ./tests/integration` passed (115.384s) in isolated Compose project `makerspace-ui-refactor-1791733168742`, port55439. Its containers/network/testvolumes were removed afterward; development data was not used.
- `make check-generated` passed against the current dirty-tree baseline; API and sqlc bindings are fresh. Backend `gofmt -l .` and `go vet ./...` passed in Compose.

- AP02 native Carbon menu instances preserve keyboard focus; route effects expand only a closed active group. Focused tests cover Enter/Escape/reopen and mobile close. AP10 fixed the concurrent role-test failure caused by closed modal buttons remaining mounted; AP01 now also removes closed destructive dialogs from the DOM.
- AP01 focus coverage checks cancel-first focus and restoration to the launcher. The common dirty guard covers route/query exits and beforeunload, and scopes discard/submit bypass to one action.
- Lead compatibility regression: `vitest run src/features/users/UserDetailPage.test.tsx src/features/auth/permissions.test.ts` passed21/21 (53.33s). Focused Playwright app tests for protected shell/Axe, responsive Directory detail, readable headers, and mobile navigation passed4/4 (14.1s).
- Lead reproduced and fixed focus loss on conditional destructive-dialog unmount; shared/PageShell tests now17/17. Billing/operator lookup authorization tests18/18 passed. Current full TypeScript check passed after the latest Events checkpoint.
- Two GPT-5.6 Sol workers stopped at a usage limit. User explicitly authorized continuing with the available model configuration. AP05/AP06 now use replacement workers; all partial code and outstanding acceptance work remain tracked, no package was marked complete because a worker stopped.
- AP10 focused run:63/64 passed (62.08s); only device-type test raced the async type lookup. Changed its query to await the loaded Delete button. Device+Role rerun16/16 passed (7.39s). Focused implementation lint passed. Browser role confirmation now checks alertdialog/cancel-first focus and return to the overflow trigger; lead fixed the real lost-focus issue with an explicit launcher ref, and browser/Axe passed1/1 (4.5s).
- General machine-detail route integrated lazily with machines.read; legacy printer route retained. AP06 owns behavior and authorization tests.
- Events handoff: focused TypeScript/lint,10/10 unit and4/4 Playwright passed, overflow checks at320/390/414/768/1440. Independent review found role-checkbox dirty tracking and form-toggle draft-loss cases; fixes and regression tests in progress.
- AP06 browser checks exposed Carbon Modal's captured Escape callback. Lead added stable latest callbacks, fixed shared dirty/pending handling, and added regressions for editing after opening and mutation starting after opening. Shared tests14/14 and focused lint passed. Feature workers apply the callback contract to their own dialogs.
- Open Days period toolbar's inner Carbon content also required auto block size. Lead app.spec checks now include actual card/button bounds, beyond overflow/visibility. Both toolbar/table/mobile-card browser tests passed2/2 (12.9s).
- AP06 final:18/18 unit and5/5 expanded browser flows passed at320/390/414/768/1440, with25 route/Axe checks, edit/discard/focus/footer and explicit status-clipping coverage. Screenshot artifacts: /private/tmp/makerspace-ui-ap06-results-20261011. No material findings accepted without a fix.
- AP09 independent organization/pricing access and foreign-query denial tests passed24/24 together with auth helpers. Existing optimistic configuration edit test passed after awaiting the loaded action (header now remains visible during independent panel loading). Five-width configuration/overview/statistics Axe, overflow, form discard/footer flows passed5/5 (41.9s). Visual review found short chart headings/status tags truncated on320px; refinements in verification.
- Intermediate full `pnpm build` passed after AP06/AP09 integration: initial static JS202128/225000 gzip bytes, CSS71473/80000. Charts remain outside the initial graph. Final measurement remains required after AP07/AP08 and reviews.
- 2026-10-12 status check: full frontend run had 6 failing tests and 3 lint warnings. Fixed: Open Day create dialog did not mark its draft dirty when NumberInput step buttons changed Supervisors/Trainees/recurrence weeks (no native change event reached `onChangeCapture`), so Escape discarded without confirmation; it now marks touched explicitly. Moved material form helpers to `materialForm.ts` (react-refresh lint). Updated Machine Logbook tests for the dual table/card layout, the reworded stale-review notice, and the new `machines.read`/`inventory.read` lookup gating. Results: tsc and lint passed, Vitest 285/285, `pnpm build` JS 202136/225000 and CSS 71473/80000 gzip bytes. Integration and Playwright checks were not rerun.
