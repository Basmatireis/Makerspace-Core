# In-app notifications

Notifications are short messages shown in the bell of the application header. They are unrelated to the mail and SMS messages composed by `internal/notifications`; the feature lives in `backend/internal/inbox` (HTTP tag _Notifications_).

## Model

- `inbox_notifications` holds the content once: `kind`, `title` (up to 120 characters), plain-text `body` (up to 2000), an optional `link` (either an application-relative path starting with a single `/` or an absolute `https://` URL of another site, no backslash or whitespace; a bare host such as `www.example.org/x` is stored as `https://`; `http://` and other schemes are refused; checked in the service and by a constraint), the sending account (manual messages only; set to null when the account is deleted) and `expires_at`.
- `inbox_recipients` has one row per account that received it, with `read_at`. Recipients are resolved when the notification is created and never change afterwards (a person who gets a role later does not receive earlier messages).
- `inbox_notification_roles` remembers the roles a manual message was sent to, for the sent list.
- **Retention:** 90 days. Expired rows are hard-deleted by a lazy sweep (at most every 10 minutes per process) when notifications are read. Dismissing deletes the account's recipient row; a system notification nobody holds any more is deleted with the last copy. Manual messages stay until they expire so the sent list stays complete.

## API

| Operation                         | Permission           | Notes                                                                                |
| --------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `GET /notifications`              | staff session        | Own notifications, newest first, `page`/`pageSize`, plus `unreadCount`.              |
| `GET /notifications/unread-count` | staff session        | Polled by the header every 60 s (paused while the tab is hidden).                    |
| `POST /notifications/{id}/read`   | staff session        | Idempotent. Another account's id answers 404.                                        |
| `POST /notifications/read-all`    | staff session        | Own notifications only.                                                              |
| `DELETE /notifications/{id}`      | staff session        | Dismiss: deletes the own copy. Another account's id answers 404.                     |
| `POST /notifications/messages`    | `notifications.send` | Title, text, optional link, 1 to 100 roles. 422 `no_recipients`, 422 `unknown_role`. |
| `GET /notifications/messages`     | `notifications.send` | Sent messages with role names, recipient and read counts.                            |
| `PUT /notifications/messages/{id}`    | `notifications.send` | Edit title, text and link of a sent message; the change reaches every copy, read or not. Recipients and roles stay. Audit `inbox_message.updated` (changed field names). 404 for expired or system notifications. |
| `DELETE /notifications/messages/{id}` | `notifications.send` | Retract: deletes the message and every recipient's copy. Audit `inbox_message.retracted`. 404 for expired or system notifications. |

Reading, marking and dismissing are scoped by the session's account id in every query. Sending fans out to the _enabled_ accounts of everyone holding any chosen role in the sending transaction, together with the audit event `inbox_message.sent` (changed field names only, never the text). A sender may send at most 10 messages per hour (429 `notification_rate_limited`). Recipient and read counts of the sent list leave out people who dismissed the message.

## System notifications

The notifications the application writes itself are **central rules of the service category**, seeded by migration 00114 (`system_key` set, enabled, editable in the notification center like any other central rule). The feature that causes an event reports it through `notifyrules.SystemEvents` (`internal/notifyrules/system_events.go`), which loads the facts of the business event, fills a `notifyrules.Event` and hands it to the dispatcher inside the transaction of the mutation, so a notification exists exactly when its trigger committed. The features that emit declare the narrow interface they need (`laborordnung`, `opendays`, `people`, `machinelogbook`, `printerconnectors`) and receive `notifyrules.NewSystemEvents(dispatcher)` from their constructor. Who is told what is decided by the rules of the trigger only; an event whose rules name nobody writes nothing.

| System key                         | Trigger and when it is raised                                                                                                                  | Default audience and channels                                                                                                                                 | Link                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `lab_rules_published`              | `lab_rules_published`: the scheduler job `laborordnung.announce` (every minute and at start) finds that the current Lab Rules version became effective and was never announced. It runs once per version (`laborordnung_versions.announced_at`, locked with `FOR UPDATE SKIP LOCKED`); older versions that were never announced are marked with it and not announced, and versions in effect when migration 00104 ran count as announced. Confirming marks the person's notifications of this rule read. | `need_confirm`: people with an enabled account whose roles ask for the Lab Rules (`warning` or `blocking`) and who have not confirmed that version. In-app and e-mail (while mail delivery is on). The rule is **mandatory**: nobody can switch both channels off. | `/lab-rules/confirm`                     |
| `open_day_period_open`             | `period_opens`: a period moves from draft to staffing (sign-up opens). Reopening a published period stays quiet.                               | `staffing_people`: enabled accounts of people whose roles have a staffing level (supervisor or trainee). In-app.                                              | `/open-days/{periodId}`                  |
| `open_day_place_freed`             | `place_freed`: someone leaves, or is removed from, a _supervisor_ place of a scheduled open day that starts within the warning window of the staffing rules (14 days by default). Trainee places never do. | `free_supervisors`: supervisors with an enabled account who are not assigned to that timeslot, except who just left. In-app.                                  | `/open-days/{periodId}/days/{openDayId}` |
| `open_day_timeslot_changed`        | `open_day_timeslot_changed`: a schedule save (day edit, series update, rejoin) moves the times of a timeslot a person holds. One event per person and open day and save, listing the new and earlier times. | `self`: the person holding the place, with an enabled account. In-app and e-mail. Never the person who saved.                                                 | `/open-days/{periodId}/days/{openDayId}` |
| `open_day_timeslot_removed`        | `open_day_timeslot_removed`: a schedule save removes a timeslot (or shrinks a series, or a day edit drops the timeslot) a person held, so their place is gone. | As above.                                                                                                                                                     | `/open-days/{periodId}/days/{openDayId}` |
| `open_day_cancelled`               | `open_day_cancelled`: a schedule save cancels an open day (or deletes it in a draft period, or a series shrink cancels it) on which a person held a place that had not ended. Takes precedence over the other two for the same person and day in one save. | As above.                                                                                                                                                     | `/open-days/{periodId}/days/{openDayId}` (the period for a deleted day) |
| `open_day_assigned_by_other`       | `open_day_assigned_by_other`: somebody else assigns a person to a timeslot (`open_days.assign`). Signing oneself up never notifies.            | `self`: the assigned person, as above.                                                                                                                        | `/open-days/{periodId}/days/{openDayId}` |
| `open_day_unassigned_by_other`     | `open_day_unassigned_by_other`: somebody else removes a person from a timeslot, or changes their membership to Visitor so their upcoming places are freed (one event per open day). Leaving oneself never notifies. | `self`: the removed person, as above.                                                                                                                         | `/open-days/{periodId}/days/{openDayId}` |
| `run_finished`                     | `run_finished`: the machine's final report sets a recorded run's outcome (connector ingest, same transaction), or a running manual run is cancelled. A run without a job raises nothing, and the person who cancels their own manual run is excluded from the event (`Event.ExcludedPeople`), whatever the rule's recipients say. | `operator` (the operator of the run's job), in-app. The rule can add `recipient` (the job's recipient, a person, or the contact e-mail of an organization), a role, and an e-mail action. | `/workshop/jobs/runs/{runId}`     |
| `printer_error`                    | `printer_error`: a connector reports a printer error (`printer_event` transition `appeared`) that is not already open for that assignment. Repeats of an open error and `cleared` transitions raise nothing (the connector decides); the same code is raised again once it was cleared and reappears. The body names the code as the printer shows it, its level and the meaning recorded in the error catalog. The event carries the token `printer_error:<machine>:<code>` and the throttle subjects machine and code. | `operator` (the operator of the job of the run that is printing on the machine), in-app, **from level "serious" on** (condition `e.level gte serious`; print errors and codes without a level carry no `e.level` and always count). The rule can add `recipient`, a role, `present` (everyone checked in) and an e-mail action; the minimum level can be changed or removed. | `/workshop/machines/{machineId}/printer` |
| `filament_loaded`, `filament_unloaded`, `filament_unknown_tag`, `filament_no_tag` | `filament_change`: a Bambu connector's `slot_observation` (live, not the catch-up after a connector start) shows a change in a slot. One rule per change (condition `e.change is …`, so each text can be edited on its own): a spool Core knows by its RFID tag was loaded (and was not there before); the slot that held a spool is empty; the tray carries a tag no spool in Core has; or the tray holds material without a readable tag. A manual mount whose tag the printer cannot read stays quiet. Without a running recorded run nothing is raised. | `operator`, in-app. The printer setup page shows the same change as a toast to whoever has it open. | `/workshop/machines/{machineId}/printer` |

A recorded run that has no job when the machine reports its end does not notify anyone, and attaching a job afterwards does not either.

**Texts.** The seeded titles and bodies reproduce the wording of the former fixed notifications. Where a sentence has optional parts the trigger offers placeholders that include the punctuation, such as `{levelNote}` (` (serious)`), `{meaningNote}` (`: Filament ran out`), `{runNote}` (` during run R-2026-000418`), `{jobNote}` (` of "Lamp shade"`) and `{materialNote}`, which are empty when the part does not apply. The open-day change triggers offer `{day}`, `{time}` (the times of the person's timeslots, a moved one says what it was), `{slots}` (timeslot or timeslots) and the matching verbs.

**Migration 00114.** It creates the rules above in the service category, translates the rows of `printer_notification_rules` (migration 00098) into them (operator becomes `operator`, recipient `recipient`, the role `role:<id>`, e-mail an extra e-mail action with the same recipients, the minimum severity the condition `e.level gte <level>`; an event nobody was told about becomes a disabled rule) and drops `printer_notification_rules` and `printer_notification_settings`. `GET`/`PUT /printer-notification-settings` and the Printers tab form are gone; the tab points to the notification center. The inbox kinds of the former notifications stay in the `kind` constraint so notifications written before the migration keep showing; new ones are kind `rule`. The down migration recreates the tables with their defaults and deletes the seeded rules.

**Organizations.** An event can name organizations per recipient key (`Event.Organizations`); an e-mail action reaches them through their contact e-mail, with no conditions, preferences or consent (the job's recipient may be an organization).

**E-mail delivery.** The dispatcher writes the e-mail into `notification_mail_outbox` in the transaction of the event, naming the person or organization but never an address. The scheduler job `inbox.mail_delivery` (every minute and at start) reads the address when it sends, uses the branded layout with a button to the notification's link, and deletes the row once sent. A recipient without an address, a deleted person or organization, switched-off mail delivery, five failed attempts or an age of a day drop the mail. Neither addresses nor message bodies are logged. Manual runs have no end event (their end time is set in advance), so only cancelling one notifies.

## Rule dispatch

Feature code reports what happened with `notifyrules.Dispatcher.Emit(ctx, tx, event)` inside the transaction of the
mutation and calls `Resolve(ctx, tx, token, reason)` when the thing the event was about is over. Both are in
`internal/notifyrules` (`dispatch.go`, `deliver.go`, `pending.go`).

- `Emit` loads the enabled event rules (central and personal) of the trigger. Every rule runs in its own savepoint: a
  definition that cannot be read or a failing statement is logged with the rule's identifier and skipped, so rules
  never fail the mutation. Only errors that break the transaction are returned.
- Conditions use the event's `e.` fields, the loop's `i.`/`s.` values, `n.weekday`/`n.hour` (makerspace time zone),
  `n.present`, `n.openDayRunning` and `n.holiday` (academic breaks plus the public holidays of the Open Days calendar),
  and per recipient the `r.` facts `systemRole`, `roles`, `checkedIn`, `lastVisit`, `signedUpNext14`, `openDays`,
  `minimum`, `belowMinimum` and `unpaid`. The open-day facts come from `staffing.Reader`, the same code the staffing
  pages use (current semester, counting rule, role exceptions, excusals); `unpaid` is the outstanding amount of the
  person's finalized orders that no active wiRef request covers. A rule that asks for a fact that cannot be loaded
  reaches nobody instead of everybody. Conditions on fields the context lacks are ignored.
- Personal rules are subscriptions: they fire for the owner while the owner still holds the trigger's permission, and
  events about one person (`self` recipient) reach only that person's own rules.
- A rule fires (one `notification_firings` row, one throttle window) when its conditions hold and at least one recipient
  passes the `r.` conditions. A throttle per subject or per rule suppresses the whole firing; a throttle per person
  logs `throttled` rows.
- Per recipient the log records `sent`, `skipped_consent` (the category needs consent at its current text version),
  `skipped_muted` (the person's channel choice, ignored for mandatory rules whose channels would all be off),
  `skipped_condition` or `throttled`. A channel a person switched on that the rule does not use is added.
- In-app delivery writes one `inbox_notifications` row of kind `rule` (with rule, firing and category) for all
  reachable people; people without an enabled account only receive e-mail. E-mail is queued in
  `notification_mail_outbox` (kind `rule`) while mail delivery is switched on and sent by the existing mail job.
- Delayed actions, e-mail fallbacks (`emailFallbackMinutes`) and escalation steps are stored in
  `notification_pending_actions`; the scheduler job `notifyrules.pending` delivers them every minute. Escalation steps
  and fallbacks of a resolved firing, or of a firing whose in-app notification was read, are dropped. Until delivery
  tracking exists, reading counts as opened, seen and acknowledged.

## Schedules, For each and summaries

Schedule and manual rules use the same engine as event rules (`fire.go`, `schedule.go`, `collections.go`).

- **Schedules.** `daily`, `weekdays`, `weekly` and `monthly` fire at a clock time in the makerspace time zone.
  `NextRun` returns the next moment: a time that does not exist (the hour lost when clocks go forward) fires when the
  clocks jump, a time that exists twice fires once, so no day fires twice or not at all. The service stores
  `next_run_at` on create and update; the scheduler job `notifyrules.schedule` (every minute and at start) claims due
  rules with `FOR UPDATE SKIP LOCKED` in one transaction per rule, runs them, and stores the next run. A run that is
  more than two hours late is skipped, not fired. A rule without `next_run_at` only gets one, it never fires at once.
  A rule that fails is retried every five minutes and cannot hold back the others.
- **Before/after each open day.** The rule looks at the scheduled open days around now (cancelled ones never fire):
  it fires for a day when `start - hours` (before) or `end + hours` (after) has passed, at most six hours ago and
  after the rule was last saved. The handled open day is recorded in `notification_rule_runs(rule_id, run_key)` in
  the same transaction as the firing, so a restart or a second scheduler pass never fires a day twice. The rule polls
  every five minutes for open days created meanwhile. Its context is `e.supervisors/free/trainees/weekday` (and
  `e.mine` in personal rules), the placeholders `{day} {time} {supervisors} {trainees} {free}` and the recipient
  `day_team`.
- **For each (loop, mode each).** The collection (`people`, `open_days` of the current semester, `machines`, `spools`,
  `orders`, `jobs`, `articles`, `trainings`) is loaded by one SQL query per collection (at most 5000 items); the loop
  filter selects items on `i.` (plus `e.` and `n.`), then the rule's conditions are evaluated per item. Each matching
  item fires on its own: placeholders such as `{person.unpaid}`, recipients `item:<key>` (the person, the order's
  customer, the training's trainers...), throttle per `item`, a resolve token per item. Order customers that are
  organizations and job recipients are reached by e-mail only.
- **Summary.** The filtered items become `s.count`, `s.sum.<money field>` and `s.max.<days or hours field>`; the
  conditions are evaluated on those once and the rule fires once with `{count}`, `{list}` (up to 15 names),
  `{sum.x}` and `{max.x}`.
- **Escalation per item.** Steps are resolved per item. With `stopWhen = item_no_longer_matches` the pending job
  reloads the item before every step and drops the remaining steps when the filter or conditions no longer hold.
  Other stop conditions resolve through tokens: a printer error cleared by its connector
  (`printer_error:<machine>:<code>`) and a supervisor place taken again (`open_day_place:<timeslot>`) call
  `Resolve` from the same transaction.
- **Not loadable, so not offered.** There is no "filament ran empty" trigger yet, so no spool token exists for it.
- **Retention.** `notification_rule_runs` is deleted with the delivery log (90 days).

### Run now, test, dry run and activity

| Endpoint | Permission | What it does |
| --- | --- | --- |
| `POST /notification-rules/{ruleId}/run` | `notification_rules.manage` | Runs an enabled central schedule or manual rule once (a rule before/after open days acts on the next open day). Returns people reached per channel, items examined and notifications produced. Audited as `notification_rule.run`. |
| `POST /notification-rules/{ruleId}/test` | `manage` for central rules; own personal rules | Sends the first-step in-app and e-mail actions to the caller only, filled from the first matching item or the trigger's examples, and logs a firing with `test = true` (not counted in the statistics). Audited as `notification_rule.tested`. |
| `POST /notification-rules/dry-run` | `manage` for central drafts; any staff session for personal drafts | Validates the draft like a save, then evaluates it without writing: items with display values and match flag (20 examples, matches first), totals, the summary and its verdict, up to 20 recipients with the result of their `r.` conditions, and a preview per in-app/e-mail action. `estimate30` is the runs of the next 30 days times today's matches for schedules, the real occurrences of the last 30 days times today's matches for events whose source is recorded (`printer_error`, `run_finished`, `lab_rules_published`), and `null` with `estimateNote` for manual rules and events nothing records. Conditions on the event itself are not applied to the count. |
| `GET /notification-rules/activity` | `notification_rules.read` | Firings newest first (`ruleId`, `page`, `pageSize` up to 100) with channels, people reached, a result tag (`delivered`, `escalated`, `throttled`, `skipped`, `test`, `resolved`) and the delivery log per recipient: name (never an address), channel, step, status, sent and read times. |

`GET /notification-rules` already carries `stats.fired30`, `lastFiredAt` and the 14-day `sparkline` of every rule.

## Frontend

- The bell is an `IconButton` with a `badgeCount` in the header next to the profile action (Carbon's `HeaderGlobalAction` has no badge). The panel is a Carbon `HeaderPanel` whose content (`NotificationList`) is lazy-loaded and fetched the first time it is opened. Clicking a notification marks it read and follows its link; each item can be dismissed and "Mark all as read" clears the badge. Nothing is stored in the browser.
- **Directory › Messages** (`/notifications/messages`, `notifications.send`) lists sent messages and opens the "New message" dialog. Choosing roles needs `roles.read` as well, because the role list is the ordinary role catalog; without it the dialog says so. Each sent message can be edited (title, text, link; roles stay) or retracted from every recipient.
- A link that starts with `https://` opens in a new tab (`noopener,noreferrer`); an application path is followed in the app.
- While the tab is open, the 60 s unread-count poll notices new notifications and shows each one as a Carbon toast at the top; clicking the toast marks it read and follows its link. Nothing is shown for notifications that were already there when the page loaded.
