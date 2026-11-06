# Semester staffing and the personal dashboard

The lab is run by its members, the supervisors. There are no employees and no front desk: supervisors staff the open days, run the machines and take payments. Guests are students who come on open days. The app is built for supervisors; what anybody sees follows their permissions, so the guest view can change without a redesign.

## Membership

Every person holds exactly one **membership**: **Supervisor**, **Trainee** or **Visitor**. They are system roles (`roles.system_key` `supervisor`, `trainee`, `visitor`) with fixed names that cannot be renamed or deleted; their permissions stay editable like those of any role, only `master` is locked. `master` and all other roles are _extra roles_ on top of the membership. Authorization never reads the names; the system key identifies the role.

- The database guarantees the rule: a deferred constraint trigger checks at commit that a person has exactly one membership role, and an insert trigger on `people` gives every new person Visitor, so every creation path (manual, kiosk enrollment, SCIM, OIDC sign-up, bootstrap) needs no code of its own.
- **Changing it.** `PUT /people/{personId}/membership` (`people.roles.assign`, the usual privilege-subset check for the new and the old membership role, audit `person.membership_changed` with the old and new membership only) swaps the role in one transaction. Becoming a Visitor also removes the person's open-day assignments that have not started (and notifies them, see [notifications.md](notifications.md)). Assigning a membership role through the generic role endpoints switches the membership the same way; removing one directly answers 422 `membership_required`. People merge and SCIM role transfer keep the highest membership (supervisor over trainee over visitor).
- **Promotion.** Nothing is promoted automatically. After the number of open days as trainee set in the rules the Leitung sees the trainee marked _Ready for supervisor_ and switches the membership by hand ("Change membership" on the staffing page). The former `POST /people/{id}/promote-to-supervisor` no longer exists.
- Only supervisors and trainees staff; visitors have no minimum and no places.

## Staffing rules

One set of rules (`GET /staffing-rules` with `supervisor_dashboard.read` or `open_days.manage`, `PUT /staffing-rules` with `open_days.manage` and an `expectedVersion`; changes are audited) replaces the former open-days settings page and the staffing fields of roles. The rules live on People › Staffing › Rules.

| Rule                | Meaning                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor minimum  | Open days a supervisor must staff per semester, 0 to 20 (default 2; 0 switches the minimum off).                                                                             |
| Trainee minimum     | The same for trainees, 0 to 20.                                                                                                                                              |
| Trainee ready after | Open days staffed in a trainee place before the staffing page marks a trainee as ready for promotion, 1 to 20 (default 3).                                                   |
| Warning window      | Days ahead in which an empty supervisor place counts as urgent, shows on the dashboard as a free place for the person's kind and notifies supervisors, 1 to 60 (default 14). |
| Count by            | `timeslot` counts every staffed timeslot, `open_day` counts every open day with at least one staffed timeslot. With one timeslot per day both are the same.                  |
| Default deadline    | The sign-up deadline of a period that sets none: `period_end` (default) or `two_weeks_before_end`. A deadline set on the period always wins.                                 |
| Exceptions          | A minimum (0 to 20) per **extra** role. Membership roles cannot have one.                                                                                                    |
| Excusals            | Per person and period, see below.                                                                                                                                            |

**Minimum of a person.** The membership's minimum, or the lowest exception among the person's extra roles when that is lower (an exception of 0 switches the minimum off for its holders); an excusal for the period overrides both with 0. This is resolved in one place (`staffing.Minimums`) and used by the status, the staffing page and the dashboard's semester tile. The minimum source (`membership`, the exception's role name, or `excused`) is part of every row. An exception applies to everybody holding the role at once. The rules travel with the configuration export (`staffingRules` section, see [configuration-transfer.md](configuration-transfer.md)).

**Excusals.** The Leitung excuses a person from the minimum of one period with a reason (up to 500 characters): `PUT` or `DELETE /open-day-periods/{periodId}/excusals/{personId}` (`open_days.manage`). The reason is visible with `supervisor_dashboard.read` only, is part of the person's data export, is deleted with the period or the person, and never copied into the audit event.

## Semester standing

- **Semester.** A semester is an open-day period. The current semester is the non-draft, non-archived period whose dates contain today; otherwise the next upcoming one, otherwise the most recent past one. The semester carries `signUpBy`, the date shown in the dashboard's "Sign up for … more by …" hint: the period's own sign-up deadline, else the rules' default deadline.
- **Counting.** Being signed up is enough: staffed (ended) plus booked (upcoming) open days, as the rules count them, reach the minimum, and supervisor and trainee places both count, so a trainee promoted mid-semester keeps their open days. Missing the minimum costs room access; access is changed by hand in the access system, the app only shows the status.
- **Status per person.** `fulfilled` (staffed plus booked reach the minimum), `missing` (n missing), `ready` (a trainee with enough open days staffed as trainee), `excused`, `no_minimum` (minimum 0 without an excusal).
- **Warnings.** Only empty supervisor places make an open day short-staffed; empty trainee places never warn.

## Supervisor staffing page

People › Staffing (`/people/staffing`, `supervisor_dashboard.read`) has two tabs. **People** lists everyone with the supervisor or trainee membership; **Rules** holds the staffing rules and exceptions (editing needs `open_days.manage`).

The People table shows the system role and extra roles, progress against the person's own minimum, lab rules, next open day and status, sorted by what needs action, with pagination, column sorting and CSV export. The key figures (below minimum, ready for supervisor, below minimum with nothing coming up, lab rules not confirmed) are one-click filter shortcuts. The visible Filters button (red count) offers system role, status, extra role, **training**, signed up and lab rules; the search matches name, roles, training categories, status and lab rules label. The training filter uses the competency categories of the person's training records (trained or trainer, active categories and trainings only, see [trainings.md](trainings.md)); every row of `GET /supervisor-dashboard` carries them as `competencies`, readable with the same `supervisor_dashboard.read` permission.

A fixed detail panel (beside the table from 92 rem, a bottom sheet below) shows the person's upcoming open days and offers, depending on permissions: assigning them to an open day, removing an upcoming assignment, confirming the Lab Rules for them, changing the membership and excusing them for the semester. `GET /supervisor-dashboard?periodId=` evaluates another period (a draft only for `open_days.manage`).

## Personal dashboard

The dashboard (`/dashboard`, the landing page) is about the signed-in person and comes from `GET /me/dashboard`, which is always scoped to the session. A section is present only when the person may see it:

| Section                                                                                                                                                                               | Shown when                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Next up, Coming up (open-day duties and event shifts, open days can be left per timeslot)                                                                                             | always; open days need `open_days.read`                                                                                  |
| Semester progress (against the person's own minimum, `staffing.minimum`, with excusal and counting rule) and the hint for a free place of the person's kind within the warning window | the person is a supervisor or trainee and has `open_days.read`                                                           |
| Open balance and Pay now                                                                                                                                                              | `orders.read`; paying needs `payments.read` and `payments.record`, paying jobs also `orders.write` and `orders.finalize` |
| Recent orders                                                                                                                                                                         | `orders.read`                                                                                                            |
| Recent jobs, job statistics and the jobs-per-month chart                                                                                                                              | `machine_jobs.read`                                                                                                      |
| Open-day and shift statistics                                                                                                                                                         | a supervisor or trainee membership, or `open_days.signup`                                                                |

People without these see their lab-rules status and the next open days. Statistics cover all time; time spent in the space cannot be tracked, so there is no statistic based on it.

The page title greets the person by the time of day ("Good morning, Lena"). In `funGreetingShare` of a hundred visits a playful greeting from the branding configuration (Settings › Communication & appearance › Branding & legal, "Playful greetings", English, up to 50 lines of 120 characters) replaces it: a greeting containing `{name}` gets the first name in its place and stands alone; one without stands alone too. The choice is made once per visit in the browser; nothing is stored.

### Open balance and paying

The balance is always shown (also at €0.00): finalized orders of the person that still have money outstanding and no active wiRef invoice request, plus their own completely priced jobs that are not on any order. "Pay now" opens a dialog with everything ticked; unticking pays a subset, and a single unpaid order can also be paid from its menu in Recent orders. Supervisors record payments for their own orders themselves.

`POST /me/payments` does everything in one transaction: it puts the selected jobs on one new order and finalizes it, then pays every selected order in full with the entered cash or card payments, recorded by the session person, with the same audit events as at the sales counter. The client sends the total it showed; if the server's total differs the request fails with `payment_total_changed` and the dashboard reloads. Orders or jobs that are not the person's, already paid or invoiced fail with `order_not_payable` or `job_not_payable`. A repeated `operationKey` returns the first result.

A card slip that pays several orders is stored as numbered receipts (`payments.split_part`) sharing the terminal reference; recording the same slip again is still refused.
