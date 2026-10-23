# Semester staffing and the personal dashboard

The lab is run by its members, the supervisors. There are no employees and no front desk: supervisors staff the open days, run the machines and take payments. Guests are students who come on open days. The app is built for supervisors; what anybody sees follows their permissions, so the guest view can change without a redesign.

## Semester staffing

- **Semester.** A semester is an open-day period. The current semester is the non-draft, non-archived period whose dates contain today; otherwise the next upcoming one, otherwise the most recent past one.
- **Supervisor and trainee.** A role carries an optional _open day staffing_ level, `supervisor` or `trainee` (role editor). A person is a supervisor if any of their roles has the supervisor level, otherwise a trainee if any role has the trainee level. Role names are never used.
- **Minimum.** Every supervisor and every trainee must staff a minimum number of open days per semester (the general minimum, or a role's own, see below). Being signed up is enough, and supervisor and trainee places both count, so a trainee promoted mid-semester keeps their open days. Missing the minimum costs room access; access is changed by hand in the access system, the app only shows the status.
- **Promotion.** After a number of open days as trainee the Leitung makes a trainee a supervisor by hand ("Make supervisor" on the staffing page). Nothing is promoted automatically. Promotion removes the person's trainee-level roles and assigns the configured supervisor role in one transaction, with the usual role-assignment checks (`people.roles.assign`, privilege subset) and an audit event.
- **Warnings.** Only empty supervisor places make an open day short-staffed; empty trainee places never warn.
- **Settings.** Settings › Lab operations › Open days & staffing (`/settings/open-days`, `open_days.manage`) holds the minimum per semester (default 2, 0 turns it off), the open days as trainee before the staffing page marks someone as ready (default 3) and the role that "Make supervisor" assigns. `GET`/`PUT /open-day-requirements`; changes are versioned and audited.

- **Role minimum.** A role with a staffing level can carry its own _open days per semester_ (0 to 20, role editor) instead of the general minimum; empty means the general minimum. A person's effective minimum is the **lowest** override among their roles that have a staffing level and an override (an override of 0 switches the minimum off for them); a person whose roles have no override gets the general minimum. This is resolved in one place (`staffing.EffectiveMinimum`) and used by the status, the staffing page and the dashboard's semester tile. An override needs a staffing level: the API answers 422 `validation_failed` otherwise, and clearing a role's staffing level also clears its override (audited as a change of `minOpenDaysPerSemester`). Changing a role's minimum applies to everybody holding it right away; setting it needs `roles.manage`. The override travels with the configuration export (`roles` section).

Status per person: **Minimum reached** when staffed plus signed-up open days reach the minimum, **n missing** otherwise (both against the person's own minimum); a trainee with enough open days staffed as trainee is **Ready for supervisor**.

## Supervisor staffing page

People › Staffing (`/people/staffing`, `supervisor_dashboard.read`) is the Leitung's overview of everyone with a staffing level. Four key figures (below minimum, lab rules not signed, ready for supervisor, no profile picture) each set the table filter; the table shows role and trainee progress, lab rules, open days this semester against each person's own minimum (`minimum` in every row of `GET /supervisor-dashboard`), status and the last open day, sorted by what needs action, with the usual pagination. People are not assigned to open days from this page. Data: `GET /supervisor-dashboard`.

## Personal dashboard

The dashboard (`/dashboard`, the landing page) is about the signed-in person and comes from `GET /me/dashboard`, which is always scoped to the session. A section is present only when the person may see it:

| Section                                                                             | Shown when                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Next up, Coming up (open-day duties and event shifts, open days can be left)        | always; open days need `open_days.read`                                                                                  |
| Semester progress (against the person's own minimum, `staffing.minimum`) and the hint for a free place of the person's kind within 14 days | the person has a staffing level and `open_days.read`                                                                     |
| Open balance and Pay now                                                            | `orders.read`; paying needs `payments.read` and `payments.record`, paying jobs also `orders.write` and `orders.finalize` |
| Recent orders                                                                       | `orders.read`                                                                                                            |
| Recent jobs, job statistics and the jobs-per-month chart                            | `machine_jobs.read`                                                                                                      |
| Open-day and shift statistics                                                       | a staffing level or `open_days.signup`                                                                                   |

People without these see their lab-rules status and the next open days. Statistics cover all time; time spent in the space cannot be tracked, so there is no statistic based on it.

### Open balance and paying

The balance is always shown (also at €0.00): finalized orders of the person that still have money outstanding and no active wiRef invoice request, plus their own completely priced jobs that are not on any order. "Pay now" opens a dialog with everything ticked; unticking pays a subset, and a single unpaid order can also be paid from its menu in Recent orders. Supervisors record payments for their own orders themselves.

`POST /me/payments` does everything in one transaction: it puts the selected jobs on one new order and finalizes it, then pays every selected order in full with the entered cash or card payments, recorded by the session person, with the same audit events as at the sales counter. The client sends the total it showed; if the server's total differs the request fails with `payment_total_changed` and the dashboard reloads. Orders or jobs that are not the person's, already paid or invoiced fail with `order_not_payable` or `job_not_payable`. A repeated `operationKey` returns the first result.

A card slip that pays several orders is stored as numbered receipts (`payments.split_part`) sharing the terminal reference; recording the same slip again is still refused.
