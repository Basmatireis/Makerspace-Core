# Open Days

Open Days are a dedicated scheduling and staffing feature. They are not general Events and do not introduce an event abstraction.

## Lifecycle and editing

A period moves in one direction: `draft → staffing → published → archived`. Period name and date bounds can change only in draft. Schedule operations are allowed in draft, staffing, and published and are saved as one atomic delta guarded by the period version and affected Open Day versions. Removing a draft slot hard-deletes it; after staffing begins, removal records a cancellation and retains assignments and audit history. Assignment changes never bump the schedule version and are closed on cancelled Open Days and archived periods.

Self-signup and administrative assignment are available only for scheduled Open Days in staffing or published periods. The service locks the selected requirement before checking capacity, requires an enabled Account and an eligible Role at assignment time, and prevents one Person from occupying two requirements on the same Open Day. Later Role loss does not erase an existing assignment.

## Local time and calendar context

Period bounds, holidays, and academic breaks use inclusive PostgreSQL `date` values. User-entered schedule times are interpreted in the configured makerspace timezone and stored as UTC `timestamptz`. Defaults are `Europe/Vienna`, `AT`, `AT-6`, and German holiday labels. Configure them with `MAKERSPACE_TIME_ZONE`, `OPEN_DAYS_HOLIDAY_COUNTRY`, `OPEN_DAYS_HOLIDAY_SUBDIVISION`, and `OPEN_DAYS_HOLIDAY_LANGUAGE`. Invalid timezones or unsupported offline GoHoliday jurisdictions fail API startup clearly.

Academic breaks are versioned database records managed by `open_days.manage`. Public holidays are calculated offline by the pinned GoHoliday dependency behind a small provider seam. Recurrence preview identifies each date as `create`, `holiday`, `academic_break`, or `conflict`; skipped occurrences remain selectable in the editor for a deliberate local override.

## Public privacy

Anonymous `GET /api/v1/public/open-days` and `/api/v1/public/open-days/calendar.ics` expose only Open Days from currently published periods. JSON contains stable ID, generic title, UTC start/end, scheduled/cancelled state, and update time. ICS uses a stable `urn:uuid:` UID, Open Day version as `SEQUENCE`, `LAST-MODIFIED`, and `STATUS:CANCELLED` when relevant. Neither representation contains notes, requirements, assignment names, counts, or Person identifiers.

Internal readers receive staffing counts and their own assignment. Other assignment identities require `open_days.read_assignments`; internal notes require `open_days.manage`.

## Audit

Period, schedule, assignment, and academic-break mutations write privacy-minimized audit events in the same PostgreSQL transaction as their domain change. Changed-field lists contain names only. Notes, Person names, eligibility search terms, and schedule values are not copied into audit metadata.
