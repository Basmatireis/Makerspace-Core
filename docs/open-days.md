# Open Days

Open Days are a dedicated scheduling and staffing feature. They are not general Events and do not introduce an event abstraction. Who has to staff them, how many and by when is the subject of [staffing-and-dashboard.md](staffing-and-dashboard.md); this page covers the schedule itself.

## Periods

A period follows `draft ↔ staffing ↔ published → archived`. Managers may return staffing periods to draft or published periods to staffing; assignments and schedule data are retained. Returning to draft hides the period from non-management readers and closes signup, while returning to staffing removes it from public JSON and ICS without closing internal staffing. There is no direct published-to-draft transition and archived periods remain final. Period name and date bounds can change only in draft; the sign-up deadline can also change while a period is in staffing or published (an update that also changes name or bounds there answers 409 `period_not_draft`).

The optional sign-up deadline (`signUpDeadline`, a date within the period's dates, inclusive; 422 `validation_failed` otherwise) is the date by which supervisors must have signed up for their minimum, shown on their dashboard. Update requests replace it, so an omitted `signUpDeadline` clears it; a period without one uses the **default deadline** of the [staffing rules](staffing-and-dashboard.md#staffing-rules) (its end date, or two weeks before it). Managers may hard-delete a period in any lifecycle state; its Open Days, timeslots, places, series and assignments are deleted in the same transaction.

A new period can copy the weekly series of an earlier one (`copySeriesFromPeriodId`): every series restarts on its weekday's first date in the new period and generates its open days, skipping public holidays and academic breaks (except dates forced on purpose).

## Open days, timeslots and places

An open day is a date with one or more **timeslots**. Its own start and end are the overall range of its timeslots. Timeslots of a day are ordered and must not overlap each other. A timeslot has its own **places** (requirements): a number of supervisor places and a number of trainee places, so different people can staff the morning and the afternoon. The editor offers the same places and restrictions for all timeslots of a day; the API carries them per timeslot.

**Overlap rule.** Scheduled open days of one period must not overlap: any overlap of the overall ranges of two scheduled days is refused with 409 `open_day_overlap` (cancelled days do not count). Skipped occurrences of a series are those days that would collide.

**Eligibility.** The kind of a place follows the membership of the person (see [authorization.md](authorization.md#membership-roles)): only supervisors can take supervisor places and only trainees trainee places; visitors cannot staff. A place may additionally be **restricted to extra roles**: the person then needs any one of the listed roles. Membership roles cannot appear in a restriction because membership already decides. Every session sees per place whether the person is `eligible` and whether they `canJoin` (eligible, not yet in that timeslot, a place is free and signup is open).

**Assignments.** Self-signup and administrative assignment are available only for scheduled open days in staffing or published periods. The service locks the selected place before checking capacity and requires an eligible person at assignment time. One person holds at most one place per timeslot (409 `already_in_timeslot`) but may hold several timeslots of a day; a full place answers 409 `requirement_full`. Administrative assignment supports people without accounts; self-signup requires an account. Later loss of a role or a membership change does not erase an existing assignment, except that becoming a Visitor removes the upcoming ones. Leaving is per timeslot: `DELETE /open-days/{openDayId}/assignments/me` takes the required `timeslotId` query parameter. Assignment changes never bump the schedule version and are closed on cancelled open days and archived periods.

## Weekly series

A **series** describes how a period's days were generated: a weekday, a first and a last date, a timeslot template in makerspace wall-clock time, the places per timeslot, an optional role restriction and the dates that were forced. Public holidays and academic breaks are skipped unless their date is forced (included on purpose). `GET /open-day-periods/{periodId}/series` lists them.

- Editing a single day takes it out of its series (`series_id` becomes empty, the former series is remembered). **Follow the series again** puts it back with the series' timeslots and places (409 `open_day_not_detached` for a day that never left).
- **Edit series** applies the changed template to the series' scheduled, not yet started days from an apply-from date (never before today); timeslots keep their assignments by position. A later end date adds days; an earlier one removes the days after it: days in a draft period are deleted, otherwise they are cancelled and keep their assignments and history. Newly forced dates get an open day.

## The schedule editor and its working copy

The schedule page of a period (`/open-days/{periodId}`) edits a local working copy and saves **one atomic delta** (`PUT /open-day-periods/{periodId}/schedule`: created, updated and removed days, series created, updated and rejoined), guarded by the period version and the versions of the affected days. Nothing is written until the save bar is confirmed; a stale version answers 409 and the editor reloads the server state. Removing a draft day hard-deletes it; after staffing begins, removal records a cancellation and retains assignments and audit history. The sections are Upcoming, Short-staffed (managers), Open for me, Mine and Past, each as list or calendar, with a fixed detail panel (beside the list from 92 rem, a bottom sheet below). People who may only read or sign up land directly on the current period; people with `open_days.manage` start on the period list with the Periods and Breaks tabs.

Short-staffed means a supervisor place of a timeslot that has not ended is still empty. Empty trainee places never count: a day is fully staffed (also in the period's "Fully staffed" count) once its supervisor places are filled.

List and calendar colour each day from the viewer's side. People with `open_days.manage`: red while a supervisor place is free, green when all supervisor places are filled, blue when they hold a place themselves, grey when cancelled. People who sign up: red when there is a place they can take, green when every place of their own kind is taken, blue when they hold a place, grey when cancelled. A day with several timeslots shows the strongest state (blue, then red, then green).

## Local time and calendar context

Period bounds, holidays, and academic breaks use inclusive PostgreSQL `date` values. User-entered schedule times are interpreted in the configured makerspace timezone and stored as UTC `timestamptz`. Defaults are `Europe/Vienna`, `AT`, `AT-6`, and German holiday labels. Configure them with `MAKERSPACE_TIME_ZONE`, `OPEN_DAYS_HOLIDAY_COUNTRY`, `OPEN_DAYS_HOLIDAY_SUBDIVISION`, and `OPEN_DAYS_HOLIDAY_LANGUAGE`. Invalid timezones or unsupported offline GoHoliday jurisdictions fail API startup clearly.

The service rejects local times in spring-forward gaps and autumn overlaps with HTTP 422 `validation_failed` and a useful `details.reason`. It never silently normalizes a gap or chooses an overlap occurrence. Series and recurrence validate both endpoints of every timeslot on their actual calendar dates, including overnight endings. Explicit schedule instants whose local endpoints are ambiguous are also rejected. API callers should send UTC or the matching configured-zone offset; a stale local offset across a transition is rejected. The editor reports these errors without changing the working copy. Normal overnight slots and exclusive-midnight period bounds remain supported.

Academic breaks are versioned database records managed by `open_days.manage`. Public holidays are calculated offline by the pinned GoHoliday dependency behind a small provider seam. The schedule shows holidays and breaks as rows between the days; a series skips them unless the date is forced.

## Notifications and the calendar subscription

Changes to a schedule that touch a person's places notify them (in the app, and by e-mail while mail delivery is on): `open_day_timeslot_changed`, `open_day_timeslot_removed`, `open_day_cancelled`, `open_day_assigned_by_other` and `open_day_unassigned_by_other`, at most one per person and open day and save, never to the person who made the change. The first two and the cancellation take effect in the same transaction as the schedule save. The kinds, recipients and links are listed in [notifications.md](notifications.md).

Every signed-in person can subscribe to their own open-day timeslots and event shifts in a calendar application; see [calendar-feed.md](calendar-feed.md). The Open Days page links to it from the profile menu entry "Calendar subscription".

## Public privacy

Anonymous `GET /api/v1/public/open-days` and `/api/v1/public/open-days/calendar.ics` expose only Open Days from currently published periods, **one entry per open day** over its overall range. JSON contains stable ID, generic title, UTC start/end, the timeslots (start and end only), scheduled/cancelled state, update time, and the planned competencies (category ID and label only, see [trainings.md](trainings.md)). ICS uses a stable `urn:uuid:` UID, Open Day version as `SEQUENCE`, `LAST-MODIFIED`, `STATUS:CANCELLED` when relevant, the timeslots and competencies as `DESCRIPTION`, and the generation time as `DTSTAMP`. Neither representation contains notes, places, assignment names, counts, Person identifiers, trainings, or trainer rights.

Internal readers receive staffing counts, their per-place `eligible` and `canJoin`, and their own assignment. Other assignment identities require `open_days.read_assignments`; internal notes require `open_days.manage`. With the names come the assigned people's profile images: `profileImageUrl` points to `GET /open-days/{openDayId}/assignments/{assignmentId}/profile-image`, which needs the same permission and no permission to read the person; it is null when the person has no image, and the dot shows initials instead.

## Audit

Period, schedule, series, assignment, excusal, membership and academic-break mutations write privacy-minimized audit events in the same PostgreSQL transaction as their domain change. Changed-field lists contain names only. Notes, Person names, excusal reasons, eligibility search terms, and schedule values are not copied into audit metadata.
