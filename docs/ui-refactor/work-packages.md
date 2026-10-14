# Work packages

All package status lives in progress.md. Each worker reads AGENTS.md, README.md, architecture.md, deletion-matrix.md and its package below. Default validation: targeted component tests, ESLint on touched files, TypeScript; report exact commands/results and remaining risks. Meaningful browser checks are required at integration. No worker changes another worker's files or generated code.

| ID | Objective / exact scope and primary owners | Dependencies | Role / complexity / risk | Acceptance and validation | Parallel safety |
|---|---|---|---|---|---|
| AP00 | Persist six docs; record dirty baseline and approved decisions | Approval | Lead / small / low | Complete matrix, decisions, ownership, actual baseline results | Docs only |
| AP01 | Shared primitives under frontend/src/app, PersonDetailComponents extraction, initial index.scss feature split; define helper/query contracts | AP00 | Sol high / large / high | Existing Directory/Dashboard behavior; focus/dirty-dialog tests; tsc/lint/unit/build+gzip | Serial shared foundation |
| AP02 | AppShell/AppNavigation and navigation tests; SettingsPage SPA links | AP01 interfaces | Sol medium / medium / medium | Approved tree, current permission gates, active menu, phone focus/closure, legal links; unit+browser | No shared styles/route edits |
| AP03 | events/EventsPage and EventCreatePage/dialog; list styles/tests | AP01 | Sol high / large / medium | Exact columns, visible actions, safe draft deletion, modal dirty/deeplink/history/list state tests | Events exclusive; before AP04 |
| AP04 | events/EventDetailPage, extracted panels, EventEditDialogs, PublicEventPage and EventSignupManagementPage presentation | AP03 | Sol high / large / high | All six panels and workflows, ?tab, post-event permission matrix, dirty drafts/refetch, responsive/a11y, deletion confirmation | Events exclusive |
| AP05 | frontend/src/features/opendays/**, owned styles and new tests | AP01 | Sol high / large / high | Agenda/calendar, lists, recurrence two steps, bulk, staffing single dialog, privacy/DST/save/cascade tests at320/390 | Independent feature files |
| AP06 | machinelogbook/MachinesPage, new MachineDetailPage/Type dialog, PrinterProfilePage | AP01 | Sol high / large / high | Search/paging, non-printer detail, lifecycle/edit, profile404 vs errors, attempt cancel, mount lookup permissions, keyboard/mobile | Own catalog/printing files + separate styles |
| AP07 | machinelogbook/JobsPage, JobDetailPage, ReviewPage, CreateJobModal | AP01 | Sol high / large / high | Job-ID selection, queue refetch and conflicts preserve drafts, required selectors properly gated, mobile correction/review | Own jobs files + separate styles |
| AP08 | machinelogbook/InventoryPage, MaterialDetailPage, FilamentSpoolsPage, FilamentSpoolDetailPage | AP01 | Sol high / large / high | Material edit/deactivate, identifier removal, correct rights, stock history/mobile, tests | Own inventory files + separate styles |
| AP09 | machinelogbook/ConfigurationPage, OverviewPage, StatisticsPage; integrator handles route/permission/tile gates | AP02 | Sol high / large / medium | Independent permission panels/no foreign queries, existing pricing/overview/statistics, lazy charts, a11y/mobile | Own config/stat files + separate styles |
| AP10 | Existing destructive dialogs outside Events/OpenDays/MachineLogbook: users/profile/roles/devices/orders/payments/invoicing/attendance/assets | AP01 | Sol high / large / high | Consequences truthful, focus/pending/error/confirmation consistent; no new backend policies or connector changes | Disjoint files; coordinate Person extraction first |
| AP11 | Routing/shared integration, full regression/reviews, docs completion | AP02–10 | Lead/review / large / high | No material findings; full frontend checks, generation, real PG/backend, isolated E2E, production budgets/delivery | Integration serial |

## Execution

At most root + 3 workers. GPT-5.6 Sol implements; Astra reviews high-risk boundaries. Complete foundation contracts first; independent work can start only on stable interfaces/disjoint files. AP03 precedes AP04. Common route/query/style edits are serialized. On completion review, integrate, update progress and immediately dispatch next ready package. No repeated user approvals unless new destructive policy or out-of-scope choice is required.

Execution amendment (2026-10-11): after two GPT-5.6 Sol workers hit a usage limit, the user explicitly approved continuing with the available model configuration. Replacement workers inherit that available configuration; ownership and the three-worker concurrency limit remain unchanged.

## Test acceptance

Widths 320,390,414,768,1440; keyboard, axe, clipping/overlap/touch/modal footer (not just global overflow). Preserve all lifecycle/error/version/privacy rules. Run targeted tests per package, broader checks at integration. Fresh production measurement after foundations/navigation and final: recursive initial JS<=225000, entry CSS<=80000 gzip bytes. Preserve NGINX delivery behavior and chart lazy boundary. Full-stack/PG use isolated data. Do not claim unavailable/unrun checks passed.
