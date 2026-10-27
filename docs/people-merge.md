# Merging duplicate people

Duplicates happen: a visitor enrolls at the kiosk, later gets an account by invitation, and both records collect
history. `POST /people/merge/preview` and `POST /people/merge` fold up to nine duplicates ("sources") into one
**target** Person. The sources and their Accounts are permanently deleted; everything that referenced them is
re-pointed to the target and the surviving Account. The implementation lives in `backend/internal/people/merge*.go`.

## Authorization

- `people.merge` and `people.read.all` are required for both endpoints. `people.merge` is checked first, so a grant
  that only lacks a fresh sign-in answers `403 reauthentication_required` (role grants can require one with
  `reauthWithinMinutes`). Migration 00077 adds `people.merge` to the master reauthentication policy (10 minutes), so a
  master needs a `strong_mfa` sign-in within ten minutes.
- **Roles.** The target ends up with the union of all roles. Because the merged Person also receives the sources'
  authentication methods, the caller must be allowed to assign _every_ role in that union (`people.roles.assign` and
  the ordinary privilege-subset, device-scope, assurance and fresh-sign-in delegation rules), not only the new ones.
  Otherwise a caller could move their own credentials onto a more privileged Person.
- **Master.** If any involved Person holds the master role, only a master (`strong_mfa`) can merge.
- **Last master.** The merge must leave an enabled master Account: either one outside the merge or the surviving
  Account (which receives the master role through the union). Otherwise `409 last_master_required`.
- **Matriculation numbers.** The preview omits `matriculationNumber` without `people.read.matriculation`. Choosing the
  matriculation source explicitly needs `people.read.matriculation` and `people.update.matriculation` (403 otherwise);
  without a choice the target keeps its number or, when it has none, takes the first source's number, so nothing is
  lost silently and nothing is shown.
- The service makes every decision; the UI only presents it. Unauthorized conflicts appear in the preview as
  `master_merge_forbidden` / `role_assignment_forbidden` and make the merge answer `403 permission_denied`.

## Preview

`POST /people/merge/preview` with `{targetPersonId, sourcePersonIds}` is read-only and returns:

- `people`: target first, then sources in request order, with every mergeable field (first/last name, email, phone,
  matriculation number when permitted, legacy `photoReference`, profile image reference, `memberSince`), `createdAt`,
  roles, `scimManaged`, and the Account (`id`, `version`, status, provisioning source, login email, whether a password
  is set, PIN, number of OIDC identities, confirmed authenticator app, number of passkeys). No secrets, PIN usernames
  or OIDC subjects are returned.
- `resultingRoles` (the union), `survivingAccountId` (the target's Account, otherwise the first source Account in
  request order, otherwise null).
- `history`: what moves from the sources per category (`visits`, `attendance_holds`, `training_records`,
  `lab_rules_requests`, `open_day_assignments`, `event_shift_assignments`, `event_planning` (owned events and assigned
  tasks), `orders`, `machine_jobs`, `invoice_requests`, `cash_movements`, `survey_invitations`, `survey_responses`,
  `organization_memberships`, `notifications`); only non-zero categories are listed.
- `conflicts` and `canMerge`.

### Blocking conflicts

| Code                           | Rule                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_scim_managed`          | A source is provisioned through SCIM (its mapping restricts deletion). A SCIM-managed target is fine and keeps its mapping; use SCIM reconciliation for provisional SCIM accounts. |
| `actor_is_source`              | The caller's own Person is a source. Choose yourself as the target instead.                                                                                                        |
| `open_visit_conflict`          | More than one involved Person is checked in.                                                                                                                                       |
| `attendance_hold_conflict`     | More than one involved Person has a pending Lab Rules check-in hold.                                                                                                               |
| `lab_rules_request_conflict`   | Pending Lab Rules requests for different versions.                                                                                                                                 |
| `open_day_assignment_conflict` | The People hold different positions on the same Open Day.                                                                                                                          |
| `pin_conflict`                 | More than one Account has a PIN.                                                                                                                                                   |
| `totp_conflict`                | More than one Account has a confirmed authenticator app.                                                                                                                           |
| `master_merge_forbidden`       | Someone holds the master role and the caller is not a master.                                                                                                                      |
| `role_assignment_forbidden`    | The caller may not assign every role of the union.                                                                                                                                 |
| `last_master_required`         | No enabled master would remain.                                                                                                                                                    |

Open orders need no rule: orders, payments and invoice requests reference the payer only, and all of them move.

## Execute

`POST /people/merge` takes the selection, `expectedVersions` (one `{personId, version, accountVersion}` per involved
Person, `accountVersion` null for a Person without Account) and `fieldSources` (`field → personId`). It answers with
the merged `person` (the ordinary `Person` representation), `mergedPersonIds` and `moved` counts.

**Optimistic concurrency.** A changed Person or Account version, or an Account that appeared or disappeared since the
preview, answers `409 stale_write`. Conflicts answer `409 people_merge_blocked` with `details.reasons` (a single reason
keeps its own code, as for Person deletion).

**Locking.** One transaction locks the People in id order, then the master invariant advisory lock, then the Accounts
in id order (the documented people → master invariant → accounts order), re-evaluates every conflict and only then
writes.

### Field values

- An omitted `firstName`, `lastName` or `memberSince` keeps the target's value. An omitted `phone`,
  `matriculationNumber`, `photoReference` or `profileImage` keeps the target's value, or the first source's (request
  order) when the target has none. Choosing a Person whose value is empty clears the field. The result must satisfy the
  usual validation (name rules, an email or a phone).
- **Email and login.** The Person's email mirrors the login email of its Account. When the merged Person keeps an
  Account, `email` must name a Person with an Account (`422 merge_email_requires_account` otherwise; default: the
  surviving Account's Person). That Account's password identity (login email with its password) moves to the surviving
  Account; every other password identity of the involved Accounts is deleted. Without any Account the email is a plain
  field like phone.
- **Profile image.** The chosen image (a reference to the stored file) is kept; the other stored images are deleted
  after the commit (a failed file deletion is logged with the file ID and leaves only orphaned storage).

### Accounts and authentication methods

- The surviving Account is the target's; if the target has none, the first source Account (request order) is attached
  to the target. Its status is kept. Other source Accounts are deleted after their data moved.
- PIN, OIDC identities, passkeys, a confirmed authenticator app and recovery codes move to the surviving Account
  (conflicting PINs and authenticator apps block the preview; duplicate recovery-code digests are dropped).
- Unconfirmed authenticator enrolments, pending second-factor logins, WebAuthn ceremonies, OIDC flows, second-factor
  throttles, password reset tokens and one-time challenges (invitations, verification, PIN setup) of every involved
  Account are deleted. **All sessions of every involved Account are revoked**, including the caller's when the caller
  is the target.

### Records per table

Every foreign key to `people(id)` and `accounts(id)` is listed with its rule in `people.MergeReferences`
(`merge_references.go`). `TestPeopleMergeHandlesEveryReference` compares that list with `pg_constraint`, so a
migration that adds such a column fails the integration suite until the merge handles it.

| Records                                                                                                                  | Rule                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `person_roles`                                                                                                           | United on the target (`assigned_by` = caller for added roles).                                                                                     |
| `visits`, `attendance_holds`                                                                                             | Moved; more than one open visit or hold blocks the merge.                                                                                          |
| `training_records`                                                                                                       | Moved; for the same training the higher status (`trainer` over `trained`) wins, then the most recently updated, then the target's.                 |
| `laborordnung_requests`                                                                                                  | Moved; when two pending requests exist (same version, otherwise blocked), the target's wins.                                                       |
| `open_day_assignments`                                                                                                   | Moved; the same position on the same Open Day is kept once (the target's).                                                                         |
| `event_shift_assignments`                                                                                                | Moved; two active assignments to the same shift keep the target's.                                                                                 |
| `organization_members`                                                                                                   | Moved; duplicate memberships keep the target's.                                                                                                    |
| `events.owner_person_id`, `event_tasks.assignee_person_id`                                                               | Moved.                                                                                                                                             |
| `orders`, `machine_jobs` (customer, operator), `external_invoice_request_details` (recipient, contact), `cash_movements` | Moved, including finalized/immutable history (see below).                                                                                          |
| `survey_invitations`, `survey_responses.identified_person_id`                                                            | Moved. Anonymous responses never carry a Person and stay untouched.                                                                                |
| `inbox_recipients`                                                                                                       | Moved to the surviving Account; a notification delivered to both keeps the target's read state.                                                    |
| Every `*_by_account_id` / `actor_account_id` / `deleted_by` column                                                       | Re-pointed to the surviving Account (who did what is preserved).                                                                                   |
| `audit_events`                                                                                                           | `actor_account_id` and the `resource_id` of `person`/`account` events of the sources are re-pointed, so the target's activity history is complete. |
| `scim_users`                                                                                                             | A SCIM-managed source blocks; the target's mapping stays.                                                                                          |

**Immutable history.** Orders, order items and adjustments, payments and allocations, invoice request events and
details, inventory transactions, cash movements and published Lab Rules versions are protected by triggers that only
allow detaching references. Migration 00077 gives these triggers a transaction-local merge mode
(`set_config('makerspace.people_merge', 'on', true)`, set only inside the merge transaction): the original guard is
skipped and `people_merge_reference_guard` allows nothing but changes of the listed person/account reference columns
and no deletes.

### Audit

One `person.merged` event (resource: the target Person) records `changedFields` (field names only, plus `roles` and
`account`) and counts only: `countMergedPeople` and `count<Category>` for every non-zero moved category (for example
`countVisits`, `countActorReferences`, `countAuthenticationMethods`, `countAuditEvents`). No names, emails, numbers or
other values are stored. The audit writer accepts `count…` metadata keys only with decimal values.

## Web interface

Everything below is UX only; the service decides and enforces. The wizard lives at `/people/merge`
(`frontend/src/features/users/merge/`, a lazy route needing `people.merge` and `people.read.all`).

- **Entry points.** The "Merge people" batch action of the people list (enabled for 2 to 10 selected rows) and "Merge with…"
  in the actions menu of a person's detail page, both visible only with `people.merge`. They open the wizard with
  `?person=<id>` (repeated) preselected.
- **1. Select people.** Add or remove people through a name/email search (at most ten) and choose the person that stays.
- **2. Compare.** Runs the preview. Every blocking conflict is an error notification with a message per code, and
  Continue stays disabled while `canMerge` is false. Otherwise one row per field with a radio button per person.
  The default equals the server default (the target's value, or for optional fields the first non-empty one; the
  email follows the surviving account, and people without an account cannot be chosen for it). The matriculation row
  exists only when the preview carries the number. Below the table: the role union, the surviving account, every
  account's sign-in methods and the history that moves.
- **3. Confirm.** A warning names the people that are deleted; an explicit checkbox enables the danger button. The
  request carries `expectedVersions` of the preview and `fieldSources` for the fields whose choice differs from the
  default only, so a matriculation number is sent only when it was deliberately changed. `409 stale_write` offers to run the
  preview again; other 409/403/422 answers show the reason. `403 reauthentication_required` is handled by the global
  "Confirm it's you" dialog, which repeats the merge once.
- **4. Done.** Links to the merged person. When the caller merged into their own person every session ended, so the
  page says so and offers "Sign in again" instead of refreshing data.
