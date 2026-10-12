# Deletion and lifecycle capability matrix

Approved 2026-10-11. Paths below refer to the current source, never manually edit generated clients. Every mutation remains authorized by the backend and retains existing expectedVersion, reference, transaction and audit checks. Missing permission hides an action; known lifecycle restrictions explain disabled state; server conflicts stay visible. Destructive confirmations identify the record and actual cascade/detachment; cancel receives initial focus. Pending operations prevent duplicate requests; success refreshes relevant queries. No new delete endpoint or retention model is authorized.

| Entity | Existing API/operation and permission | UI disposition | Source evidence / constraints |
|---|---|---|---|
| Person | DELETE /people/{id}; people.delete, plus accounts.delete when linked | Existing action, standardize truthful consequences | internal/people/service.go Delete; users/UsersPage, UserDetailPage; last-master checks, event assignment PII scrub, operational links detach |
| Account | DELETE /accounts/{id}, disable; accounts.delete / disable | Keep both distinct workflows | internal/accounts/service.go; UserDetailPage; sessions/auth credentials cascade, Person roles remain |
| Auth identities, password, PIN | identity unlink, own credential removal; dedicated self/admin auth grants | Keep explicit removal confirmation | api/openapi.yaml auth/account operations; profile/ProfilePage, users/UserDetailPage; no token logging |
| Role, permission grants, membership | DELETE /roles/{id}, removePersonRole; roles.manage / people.roles.assign | Preserve existing delete/removal UX, standardize confirmation | internal/roles/service.go; roles/RoleDialogs, RolesPage; master protection and grant-subset rules |
| Profile image | DELETE /people/{id}/profile-image; existing person scope | Ownership-aware remove | users/ProfilePictureEditor; files/service.go |
| Audit | No user-facing delete; internal retention cleanup | No CRUD action | internal/audit/audit.go; actor reference may detach, minimized retained metadata |
| OpenDay period | DELETE /open-day-periods/{id}; open_days.manage; archive command also exists | Keep delete in EVERY state, full-cascade warning | internal/opendays/service.go DeletePeriod; docs/open-days.md; days, requirements/eligibility and assignments cascade, audit retained |
| OpenDay | DELETE /open-days/{id} in draft; cancel after staffing | Same actions on phone agenda | opendays/service.go DeleteOpenDay/Cancel; OpenDayDetailPage, ScheduleEditorPage; existing cancellation retains history |
| OpenDay assignments | self leave or administrator remove; open_days.signup / assign | Keep rights and capacity/status rules | opendays/assignments.go; names only with read_assignments |
| Academic breaks | DELETE /open-day-academic-breaks/{id}; open_days.manage | Existing delete with confirm | OpenDayManagementPage; inclusive date ranges |
| Event | DELETE /events/{id}; events.manage | ADD missing draft Delete to overview and detail | events/service.go Delete: draft AND zero assignment HISTORY; current filledCount is insufficient; 409 explanation |
| Event session | DELETE sessions/{id}; events.manage | Existing operation, ADD confirm describing detached shifts | events/schedule.go; migration00025; metadata readonly after terminal event state |
| Task list | DELETE task-lists/{id}; events.manage | Confirm tasks remain ungrouped | events/planning.go; EventDetailPage Planning |
| Event task | DELETE tasks/{id}; events.manage | Confirm task removal | events/planning.go; planning remains mutable until archived |
| Event shift and requirement | DELETE shifts/{id}, requirements/{id}; events.staffing.manage | Confirm/reference conflict | events/schedule.go; assignment references prevent unsafe removal |
| Event assignment/signup | cancel operation; events.assign or own signup token/session | Confirm cancellation, preserve privacy | events/staffing.go; PublicEventPage/EventSignupManagementPage; anonymous token remains URL fragment only |
| Event file/banner | removeEventFile; events.manage | Confirm removal/replacement; keep ownership/blob cleanup | events/files.go; public banner must be image; files mutable until archived |
| Machine type | PATCH /machine-types/{id}; machines.manage | ADD edit/deactivate/reactivate | machinelogbook/catalog.go, docs/machine-logbook.md; referenced types retained |
| Machine | PATCH /machines/{id}; machines.manage | ADD edit/status active/maintenance/retired | catalog.go; administrative status is not live telemetry; job FKs RESTRICT |
| Machine job/usages | PATCH corrections; machine_jobs.edit; clear override with override_price | Keep correction/compensation, no delete | jobs.go, queries.sql, docs/machine-logbook.md; inventory/price/order history preserved |
| Organization | PATCH active; organizations.manage | Existing deactivate/reactivate | ConfigurationPage; referenced org retained, no hard delete |
| Pricing group/rule/party assignment | PATCH active / assignment change; pricing.manage | Existing controls consistent | machinelogbook/catalog.go, ConfigurationPage; frozen historical snapshots retained |
| Material | PATCH /materials/{id}; inventory.manage | ADD edit/deactivate/reactivate | inventory.go; MaterialDetailPage currently ledger-only; no material delete |
| Inventory transaction/balance | purchase/consume/dispose/correct/empty; inventory.manage | Preserve fact-specific confirmations | immutable ledger; stock corrections append compensation, never erase history |
| Filament spool | PATCH lifecycle; filament_spools.manage | Keep edit/retire, no hard delete | spools.go; spool create ALSO needs inventory.manage; stock consume/correct requires inventory.manage |
| Spool identifier | DELETE /filament-spools/{spoolId}/identifiers/{id}; filament_spools.manage | ADD remove confirmation | api/openapi.yaml deleteFilamentSpoolIdentifier; FilamentSpoolDetailPage |
| Printer profile | PUT enabled flag; machines.manage | ADD disable/re-enable using current version | printing/service.go; distinguish GET404 from errors |
| Printer input unit/slot | Create only; machines.manage | No invented edit/delete/retire-after-create endpoint | api/openapi.yaml printer topology; slot creation supports status, persisted edit absent |
| Spool mount assignment | mount/unmount; printer_slots.assign | Existing unmount with clear consequences; no history delete | printing/service.go; mounted spool history preserved; selector also needs inventory.read |
| Print submission/attempt | lifecycle transition; print_submissions.manage | ADD current attempt Cancel when valid | PrintSubmissionDetailPage; declarations/attempts retained; no aggregate delete |
| Printer event/observed run | reconcile/link; existing grants | Preserve records and existing reconciliation | printing/service.go; dirty printer connector implementation compatibility-only |
| Order/position | cancel/reverse; draft item removal; orders.write/finalize/reverse plus read | Existing workflows, consistent confirmations | docs/orders.md; removed_at on draft item, immutable finalized snapshots |
| Payment/allocations | full receipt reversal; payments.reverse plus read | Keep reverse, no delete | docs/orders.md; immutable financial journal |
| External invoice request/events | cancel/reconcile/replace; external_invoice_requests.manage plus read | Existing workflow, external evidence retained | docs/orders.md; submitted/issued cancellation requires evidence |
| Managed device/type | revoke then DELETE device; unused type DELETE; managed_devices.manage | Preserve explicit two-step flow | manageddevices/service.go; ManagedDevicesPage; reports/capabilities cascade |
| Session policy | create/update only; session_policies.manage | No new deletion/deactivation | SessionPoliciesPage; referenced policy RESTRICT; active flag absent |
| Attendance visit | void/correct; attendance.correct | ADD missing void-with-reason confirmation for readable current visits, no record-delete button | attendance/service.go; survey invitations cancelled, aggregate/cleanup existing policy; list lookup still needs attendance.read |
| Survey/version/question/response | publish/close; surveys.manage | No new draft delete; keep answers/history | surveys/service.go; close disables trigger and pending invites; published forms/answers immutable |
| OIDC provider | enable/disable; oidc.manage | Existing lifecycle, no provider purge | authentication.md; existing sessions do not become provider deletion |
| SCIM connector/token/mapping | enable/disable, token revoke/rotate; scim.manage | Existing lifecycle; no hard delete | scim/service.go; SCIM User DELETE is deprovisioning |
| Printer connector/assignment/discovery | disable/revoke/end; printer_connectors.manage | Compatibility only, retain ongoing work | migration00034 and printerconnectors/service.go; observed/discovery/event history retained |
| Generic files | Internal owning-flow deletion, no generic UI endpoint | Do not offer arbitrary file deletion | files/service.go; owning feature authorizes and removes metadata/blob |
| Branding/mail/visitor singletons | update/enable/asset remove | Existing controls; no record purge | settings features; retain branding legal URLs |
| Lab Rules versions/acknowledgements | publish/supersede/complete; dedicated grants | Keep version/evidence history | laborordnung service/UI; no broad delete |

## Financial privacy and deferred decisions

Person deletion detaches references but retains existing Order customer and external-invoice recipient snapshots (docs/orders.md). Confirmation must not promise complete historical erasure. Approved scope explicitly defers new retention/anonymization rules, discarded automatic jobs, abandoned submissions/connectors, draft survey cleanup, obsolete session policies, and printer topology edit/delete.

## Required validation

Permission/state matrix, referenced-record conflict, stale version, failure keeps dialog/input, pending prevents duplicate submit, focus returns on cancel/success. Existing service authorization/audit/privacy/last-master integration tests remain required. No UI role-name authorization and no claim that hiding an action secures the backend.
