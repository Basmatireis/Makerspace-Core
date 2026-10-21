# Events

Events are the workshops, fairs and community days of the lab. Organizers plan them in the app; members see confirmed events and take helper places themselves; visitors see a public page and can sign up without an account.

## Domain

| Object                 | What it is                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event                  | Internal name, description, location and owner (a person); public title, description and location; status; public page and public-signup switches; files and one public banner.                                                                          |
| Session                | A programme slot visitors attend: time, optional name and location, public or internal, scheduled or cancelled.                                                                                                                                          |
| Shift                  | A helper time slot, optionally linked to a session, with its own public flag, optional signup window and status `draft`, `open`, `closed` or `cancelled` (shown as Draft, Signup open, Signup closed, Cancelled).                                        |
| Position (requirement) | What a shift needs, for example "Bar 2×": a name, the number of places and who may fill it (anyone or members with one of some roles). Positions are saved with their shift.                                                                             |
| Assignment             | One helper in one place: a linked person or a name with e-mail or phone, its source (`public_signup`, `authenticated_self` shown as Member, `authenticated_on_behalf`, `staff_entry`), active or cancelled, and a marker when an overlap was overridden. |
| Task list, task        | Planning checklist: a task is open or done, may be Important, has an optional assignee and due time.                                                                                                                                                     |

## Lifecycle

```
draft ⇄ confirmed → completed
  └──────┴──────→ cancelled
```

- **Confirm** needs an owner and at least one scheduled session or shift that is not cancelled. Confirmed events can go back to draft.
- **Completed and cancelled** are final and set `closedAt`. Details, sessions, shifts, positions and assignments become read-only; tasks and files stay editable. Personal data of signups is erased by the admin cleanup command once the event has been closed for longer than `EVENT_SIGNUP_RETENTION`.
- **Delete** works only for a draft that never had an assignment (also a cancelled one).
- **Public page.** Publishing needs a draft or confirmed event with an owner, a public title and a public scheduled session or public shift. A completed or cancelled event stays public until someone unpublishes it; it cannot be published again. The public link can be rotated while the event is open.
- **Signup** — public and in the app — opens only for **confirmed** events. A position takes signups when the shift is open, its session is not cancelled, the shift has not ended and the optional signup window is open; public signup additionally needs the public page, the public-signup switch and a public shift.

`GET /events/{id}` returns the derived `goLive` readiness so clients do not repeat these rules: the public page (`off`/`live`) and what publishing still needs, public helper signup (`off`, `open`, `opens_at` with `opensAt`, `closed`) and what it still needs, a shift summary (accepting / total / not public) and what confirming still needs, as `EventReadinessCode` values.

## Permissions

| Permission                | Allows                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `events.read`             | Confirmed and closed events with programme, planning, files and staffing counts. No drafts.                   |
| `events.manage`           | Create, edit, confirm, complete, cancel, delete, publish; sessions, tasks and files. Sees drafts.             |
| `events.staffing.manage`  | Shifts with their positions and eligibility, duplicate shifts; helper names and contacts. Sees drafts.        |
| `events.assign`           | Assign, move, cancel and link helpers, override an overlap (audited); helper names and contacts. Sees drafts. |
| `events.signup`           | Join and leave places in confirmed events for yourself.                                                       |
| `events.read_assignments` | Names (never contact details) of the other helpers.                                                           |

Drafts answer 404 to everyone without an organizer permission, in the list, the detail and every sub-resource. Migration 00060 granted `events.signup` to roles with `open_days.signup` and `events.read_assignments` to roles with `open_days.read_assignments`, `events.staffing.manage` or `events.assign`, copying each grant's scope and assurance.

## Members: helper view, join and leave

`GET /events/{id}/participation` is the participant view: the caller's own active assignments (with `canLeave`) and every shift with status open or closed, each position with filled/required, the caller's assignment, `joinable` and otherwise a `reason` (`no_permission`, `closed`, `not_open`, `opens_at` + `opensAt`, `already_joined`, `full`, `roles_only` with `roleNames`). Co-helper names are included only with `events.read_assignments`, `events.staffing.manage` or `events.assign`; overlaps are checked when joining.

- `POST /events/{id}/shifts/{shiftId}/requirements/{requirementId}/join` (`events.signup`) takes a place for the caller's own person under the capacity, role, window, duplicate and overlap rules, never with an override. 409 codes: `signup_not_open`, `signup_closed`, `already_assigned`, `person_not_eligible`, `requirement_full`, `assignment_conflict`.
- `POST /events/{id}/assignments/{assignmentId}/leave` (`events.signup`, body `expectedVersion`) gives up one's own active place while the event is open and the shift has not ended (409 `event_read_only`, `shift_ended`). Other people's assignments answer 404.

Both are audited (`event_assignment.joined`, `event_assignment.left`). The event row lock serializes every assignment change of an event, so capacity holds under concurrent joins.

## Lists

`GET /events?scope=upcoming|drafts|past&search=&ownerPersonId=&page=&pageSize=` pages events by date: `upcoming` holds confirmed events that have not ended (earliest first), `drafts` the drafts (organizers only; empty otherwise), `past` completed and cancelled events and confirmed events that have ended (latest first). Without an organizer permission `past` lists only events the caller helped at. Every item carries the staffing counts, `openPlaces`, `tasksOverdue`, `goLive` and the caller's own shifts (`myShifts`).

## Organizers

- **Programme.** `POST /events/{id}/shifts` and `PATCH /events/{id}/shifts/{shiftId}` save a shift with its complete list of positions in one transaction: a position with `id` is updated, one without is created and a missing one is deleted. Removing a position with any assignment history fails with `requirement_has_assignments`; fewer places than active helpers fail with `requirement_below_assignments`. Shifts are returned with their positions. `POST /events/{id}/shifts/{shiftId}/duplicate` copies a shift and its positions as a draft without helpers.
- **Create.** `POST /events` takes an optional `firstSession` that is created in the same transaction; new events are drafts.
- **Helpers.** `GET /events/{id}/helpers` groups the active assignments by helper (person, else e-mail, phone or name) with their shifts, sources and override markers, and lists what needs attention: public signups not linked to a person (with matching people for `events.assign`) and overridden overlaps. It needs a helper-name permission; contact details need `events.staffing.manage` or `events.assign`. Assign, move, cancel and link stay at `/events/{id}/assignments`.
- **Tasks.** `GET /events/{id}/tasks?mine=&overdue=&includeDone=` filters by assignee, overdue (open and past its due time) and done. Tasks carry the assignee's display name (`assigneeName`, null when the person was deleted).

## Screens

- **List** (`/events`). Upcoming, Drafts (organizers only) and Past are server-paged. Organizers get Date, Name, Status, Public page, Helper signup, Places filled, Tasks (overdue in red) and Owner; everyone else gets Date, Event, Open places and Your shifts. Narrow screens show cards.
- **Participant view** (`/events/:id`). Header with a key-value strip, "You are signed up" with Leave (confirmed), the programme by day with sessions and their shifts, positions with "x of y filled" and Join or the reason it is not possible, helper names only when the server sends them. Organizers get Edit event; people with only `events.assign` get Assign on open places and Manage helpers.
- **Edit mode** (`?mode=edit&tab=overview|programme|helpers|tasks|public|files`). Tabs depend on permissions: Programme needs `events.manage` or `events.staffing.manage`, Helpers one of those or `events.assign` (names and contacts as the server allows), Tasks, Public page and Files `events.manage`. The header holds View as helper, Go live (the readiness checklists come from `goLive`, each item links to where it is fixed) and the lifecycle actions; delete explains why it is unavailable.
- **Public page** (`/events/public/:publicId`) renders outside the app shell; the Public page tab previews the same component with data built from the organizer's view.

## Integrations

- The personal dashboard's Coming up lists the person's shifts of confirmed and completed events.
- The signage calendar shows the next public session of every published draft or confirmed event.
- Every change writes its audit event in the same transaction and never records personal data.
