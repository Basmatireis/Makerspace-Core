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
| `GET /notifications/unread-count` | staff session        | Polled by the header every 60 s (paused while the tab is hidden). Records that the account is online and returns `fresh` (not yet shown) and `pinned` (banners and dialogs that stay) notifications. |
| `POST /notifications/{id}/read`   | staff session        | Idempotent. Another account's id answers 404.                                        |
| `POST /notifications/read-all`    | staff session        | Own notifications only.                                                              |
| `DELETE /notifications/{id}`      | staff session        | Dismiss: deletes the own copy. Another account's id answers 404.                     |
| `POST /notifications/messages`    | `notifications.send` | Title, text, optional link, 1 to 100 roles. 422 `no_recipients`, 422 `unknown_role`. |
| `GET /notifications/messages`     | `notifications.send` | Sent messages with role names, recipient and read counts.                            |
| `PUT /notifications/messages/{id}`    | `notifications.send` | Edit title, text and link of a sent message; the change reaches every copy, read or not. Recipients and roles stay. Audit `inbox_message.updated` (changed field names). 404 for expired or system notifications. |
| `DELETE /notifications/messages/{id}` | `notifications.send` | Retract: deletes the message and every recipient's copy. Audit `inbox_message.retracted`. 404 for expired or system notifications. |

Reading, marking and dismissing are scoped by the session's account id in every query. Sending fans out to the _enabled_ accounts of everyone holding any chosen role in the sending transaction, together with the audit event `inbox_message.sent` (changed field names only, never the text). A sender may send at most 10 messages per hour (429 `notification_rate_limited`). Recipient and read counts of the sent list leave out people who dismissed the message.

## System notifications

The notifications the application writes itself are **central rules of the service category**, seeded by migration 00115 (`system_key` set, enabled, editable in the notification center like any other central rule). The feature that causes an event reports it through `notifyrules.SystemEvents` (`internal/notifyrules/system_events.go`), which loads the facts of the business event, fills a `notifyrules.Event` and hands it to the dispatcher inside the transaction of the mutation, so a notification exists exactly when its trigger committed. The features that emit declare the narrow interface they need (`laborordnung`, `opendays`, `people`, `machinelogbook`, `printerconnectors`) and receive `notifyrules.NewSystemEvents(dispatcher)` from their constructor. Who is told what is decided by the rules of the trigger only; an event whose rules name nobody writes nothing.

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

**Migration 00115.** It creates the rules above in the service category, translates the rows of `printer_notification_rules` (migration 00098) into them (operator becomes `operator`, recipient `recipient`, the role `role:<id>`, e-mail an extra e-mail action with the same recipients, the minimum severity the condition `e.level gte <level>`; an event nobody was told about becomes a disabled rule) and drops `printer_notification_rules` and `printer_notification_settings`. `GET`/`PUT /printer-notification-settings` and the Printers tab form are gone; the tab points to the notification center. The inbox kinds of the former notifications stay in the `kind` constraint so notifications written before the migration keep showing; new ones are kind `rule`. The down migration recreates the tables with their defaults and deletes the seeded rules.

**Organizations.** An event can name organizations per recipient key (`Event.Organizations`); an e-mail action reaches them through their contact e-mail, with no conditions, preferences or consent (the job's recipient may be an organization).

**E-mail delivery.** The dispatcher writes the e-mail into `notification_mail_outbox` in the transaction of the event, naming the person or organization but never an address. The scheduler job `inbox.mail_delivery` (every minute and at start) reads the address when it sends, uses the branded layout with a button to the notification's link, and deletes the row once sent. A recipient without an address, a deleted person or organization, switched-off mail delivery, five failed attempts or an age of a day drop the mail. Neither addresses nor message bodies are logged. Manual runs have no end event (their end time is set in advance), so only cancelling one notifies.

## Event triggers

Every trigger of the catalog (`notifyrules/catalog.go`, `catalog_triggers.go`) has a real source: the feature raises it through `SystemEvents` inside the transaction of its mutation, through a one-method interface it declares itself and receives with `WithNotifications` (or its existing notifier). Features built without the notifier raise nothing, so tests that do not care stay unchanged. A trigger needs its permission to be seen in a central or personal rule, so the editor of a central rule must hold it too.

| Trigger | Raised by | Recipients | Fields | Permission |
| --- | --- | --- | --- | --- |
| `check_in` | `attendance`: password, PIN, supervised and enrolment check-in | `self`, `on_duty` | system role, Lab Rules at check-in, first visit, method, terminal | `attendance.read` |
| `check_out` | `attendance`: credentials, public tap and supervised check-out | `self`, `on_duty` | system role, hours stayed, method | `attendance.read` |
| `account_created` | `accounts.Create` | `self` | system role | `accounts.read` |
| `training_recorded` | `trainings.SetRecord` when the status becomes trained or trainer | `self`, `trainers` | training, status | `training_records.read.all` |
| `order_created` | `orders` finalize (an order leaves draft) | `customer`, `creator` | amount, customer type | `orders.read` |
| `payment_recorded` | `orders` cash and card receipts and the payment a wiRef invoice settles | `booker`, `customer` | method, amount | `payments.read` |
| `cash_count_difference` | `orders.RecordCashCount` when the difference is not zero | `counter` | difference | `cash_movements.read` |
| `wiref_invoice_status` | `orders` invoice request actions that change the state | `creator` | new status | `external_invoice_requests.read` |
| `job_created` | `machinelogbook`: manual jobs and jobs created from a run | `operator`, `recipient` | machine, recipient type | `machine_jobs.read` |
| `survey_answered` | `surveys` invitation and share-link submissions | none (roles and people) | survey, rating of the first rating question, anonymous | `surveys.read` |
| `role_changed` | `people.ChangeRole` (also a switched system role) | `self` | change, role, privileged | `roles.read` |
| `privacy_request_created` | `subjectrequests.Create` | none (roles and people) | request type | `privacy.requests.manage` |
| `open_day_signup` | `opendays` sign-up and assignment | `self`, `day_team` | place type, days until, weekday, signed up by themselves | `open_days.read` |
| `open_day_period_changed` | `opendays.TransitionPeriod` (to published) and `SaveSchedule` (days, timeslots or series changed) in a staffing or published period; a draft stays quiet. One event per save | `staffing_people` | period name, change (`published` or `changed`), number of scheduled days | `open_days.read` |

Definitions that need a word. **On duty** are the supervisors (system role) who have an open visit at that moment; the arriving or leaving person is not in the list. **Privileged** is the master role or a role that grants any permission ending in `.manage`. **First visit** means no earlier visit that still counts. **Lab Rules at check-in** is "not confirmed" when the visit was admitted with a warning and "confirmed" otherwise, including roles without Lab Rules.

**Privacy.** `survey_answered` carries the survey name and the rating only: no respondent, no free text, no person recipient, for anonymous and identified surveys alike. Placeholders hold names only where staff see the same names in the application (visits, orders, people, privacy requests) and never addresses, tokens or request bodies.

**Not offered.** There is no trigger for jobs that need attention (the flag is derived when a job is read, no transition exists to hook), for repeated failed sign-ins (the authentication code keeps its throttles in separate transactions and has no notifier; a notification per failure would also let anybody trigger mail to the account owner), for a run that starts (runs begin in several connector ingest paths, none of them a single start event) or for an automatic check-out (visits are not closed automatically).

The dry run counts the real occurrences of the last 30 days for every trigger except `role_changed`, whose past is not recorded as events.

## Rule dispatch

Feature code reports what happened with `notifyrules.Dispatcher.Emit(ctx, tx, event)` inside the transaction of the
mutation and calls `Resolve(ctx, tx, token, reason)` when the thing the event was about is over. Both are in
`internal/notifyrules` (`dispatch.go`, `deliver.go`, `pending.go`).

- `Emit` loads the enabled event rules (central and personal) of the trigger. Every rule runs in its own savepoint: a
  definition that cannot be read or a failing statement is logged with the rule's identifier and skipped, so rules
  never fail the mutation. Only errors that break the transaction are returned.
- Conditions use the event's `e.` fields, the loop's `i.`/`s.` values, `n.weekday`/`n.hour` (makerspace time zone),
  `n.present`, `n.openDayRunning`, `n.supervisorsOnline` (people with the system role Supervisor whose account had the app open in a visible tab within the last two minutes, from `account_presence`) and `n.holiday` (academic breaks plus the public holidays of the Open Days calendar),
  and per recipient the `r.` facts `systemRole`, `roles`, `checkedIn`, `lastVisit`, `signedUpNext14`, `openDays`,
  `minimum`, `belowMinimum`, `unpaid` and `appOpen` (the person has an account with the app open, same two-minute window). The open-day facts come from `staffing.Reader`, the same code the staffing
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
  after the rule was last saved. `hours` is 0 to 168 (seven days), so "two days before" is 48. The handled open day is recorded in `notification_rule_runs(rule_id, run_key)` in
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
| `POST /me/notification-subscriptions/{subscriptionId}/test` | any staff session | The same test for the caller's own personal subscription; a central rule or another account's rule answers 404. Nothing is sent to anyone but the owner. |
| `POST /notification-rules/dry-run` | `manage` for central drafts; any staff session for personal drafts | Validates the draft like a save, then evaluates it without writing: items with display values and match flag (20 examples, matches first), totals, the summary and its verdict, up to 20 recipients with the result of their `r.` conditions, and a preview per in-app/e-mail action. `estimate30` is the runs of the next 30 days times today's matches for schedules, the real occurrences of the last 30 days times today's matches for events whose source is recorded (`printer_error`, `run_finished`, `lab_rules_published`), and `null` with `estimateNote` for manual rules and events nothing records. Conditions on the event itself are not applied to the count. |
| `GET /notification-rules/activity` | `notification_rules.read` | Firings newest first (`ruleId`, `page`, `pageSize` up to 100) with channels, people reached, a result tag (`delivered`, `escalated`, `throttled`, `skipped`, `test`, `resolved`) and the delivery log per recipient: name (never an address), channel, step, status, sent and read times, and for the in-app copy `deliveredAt`, `seenAt` and `acknowledgedAt` (the earliest time on any of the person's accounts, `null` while it has not happened). |

`GET /notification-rules` already carries `stats.fired30`, `lastFiredAt` and the 14-day `sparkline` of every rule.

### Open-day notifications

- **Schedule published or changed.** The trigger `open_day_period_changed` (area Open Days) reaches `staffing_people`. Its fields are the period name, `change` (`published`, `changed`) and the number of scheduled days; its throttle subject is the period, so a rule can say "at most once per period" to quiet a burst of saves. A save in a draft period raises nothing; `period_opens` still announces the draft becoming open for sign-up.
- **A slot I hold changes.** `open_day_timeslot_changed`, `open_day_timeslot_removed`, `open_day_cancelled`, `open_day_assigned_by_other` and `open_day_unassigned_by_other` (system notices, see above).
- **Reminder for my upcoming slot.** The ready-made subscription "Reminder for my upcoming open-day slot" (My notifications) is a personal rule before each open day (48 hours, editable up to 7 days) with the condition `e.mine`, so only people signed up for that day are reminded. "Remind me before my open day" is the same in hours.
- **Open day below its minimum.** The ready-made subscription "Free open days while I'm below my minimum" and rules over the `open_days` collection (`i.free`, `i.startsIn`) cover this.

## Signage and tablet notices

The `signage` and `tablet` actions address displays and entrance tablets, not people. They are separate from signage announcements: a rule notice is plain text (no template, no media, no job data) that lives in its own table and ends by itself.

- **Signage** (`signage_rule_notices`): one row per chosen display, `starts_at = now`, `ends_at = now + durationMinutes`. `GET /signage/player/live` lists the display's notices in force as `ruleNotices`; the player draws them above the scene with the announcement tone colours and hides them at `endsAt` (also when polls fail). Resolving the firing's token ends them at once.
- **Tablet** (`kiosk_rule_notices`): one row per chosen tablet, sharing a `group_id` per delivery. `banner` shows on the start screen for a day, `everyone_today` on the result screen of every check-in until local midnight, both through `GET /terminal/context` (`notices`, polled once a minute). `person_checkin` (10 minutes) and `next_checkin` (30 days) address the event's `self` recipient and are returned once, in the `notices` of that person's terminal check-in response (`Visit.notices`); all copies of a `next_checkin` notice are used up together. `mustTap` keeps the result screen until the person presses OK (banners ignore it).
- Person modes respect the category's consent and the rule's recipient conditions; an event without a `self` person skips them. Test sends and dry runs never write notices. Both endpoints are device-authenticated; a notice is never served to another person or tablet. Ended notices are deleted by the delivery retention.

## Frontend

- The bell is an `IconButton` with a `badgeCount` in the header next to the profile action (Carbon's `HeaderGlobalAction` has no badge). The panel is a Carbon `HeaderPanel` whose content (`NotificationList`) is lazy-loaded and fetched the first time it is opened. Clicking a notification marks it read and follows its link; each item can be dismissed and "Mark all as read" clears the badge. Nothing is stored in the browser.
- **Directory › Messages** (`/notifications/messages`, `notifications.send`) lists sent messages and opens the "New message" dialog. Choosing roles needs `roles.read` as well, because the role list is the ordinary role catalog; without it the dialog says so. Each sent message can be edited (title, text, link; roles stay) or retracted from every recipient.
- A link that starts with `https://` opens in a new tab (`noopener,noreferrer`); an application path is followed in the app.
- While the tab is open and visible, the 60 s poll (`GET /notifications/unread-count`) returns the notifications the account was not shown yet (`fresh`) and marks them delivered. A rule's in-app options decide how each looks: bell only, a pop-up (Carbon toast at the top, closing after the chosen seconds or when closed), a banner (inline notification below the header) or a dialog (Carbon modal; red for errors), each with a level (information, success, warning, error) and an optional OK, Acknowledge or link button. Banners and dialogs stay until they are closed, acknowledged or postponed with "Remind me later" (one hour, `POST /notifications/{id}/later`) and come back after a reload (`pinned`); when only the button may close them, there is no close icon and Escape does nothing. Closing marks the notification read, Acknowledge calls `POST /notifications/{id}/acknowledge` (acknowledged and read), and anything on screen while the tab is visible is reported with `POST /notifications/{id}/seen`. The bell list shows the level as an icon and a left border.
- Delivery tracking per recipient (`inbox_recipients`: `delivered_at`, `seen_at`, `acknowledged_at`, `snoozed_until`) drives the rule engine: an e-mail fallback goes only to accounts that never got the notification on screen and did not read it; an escalation's stop condition `opened` looks at `read_at`, `seen` at `seen_at` (opening counts), `acknowledged` at `acknowledged_at` of any recipient of the firing. "Only online" notifications reach only accounts whose latest visible poll (`account_presence`, one timestamp per account, no history) is less than two minutes old; the others are logged as `skipped_offline`. Notifications that existed before the delivery tracking count as delivered.

## Retention of consents and the settings summary

- **Withdrawn consents.** `notification_consents.withdrawn_at` (migration 00120) is set when a granted answer turns into a "no" and cleared when the person grants again. A first "no" is a decline and has no withdrawal time. The privacy category `notifications.consents` (trigger "ended") deletes consents three years after the withdrawal; a decline that was never granted stays while the person exists.
- **Tablet survey offers.** The category `surveys.offers` deletes offers one day after they expired. The next offer still removes them lazily as well.
- **Data-subject export.** The export of `surveys.invitations` is an object with `invitations` and `askCooldowns` (survey title and the UTC date the tablet last asked, never an answer).
- **My notifications.** Each reaching rule in `GET /me/notifications/settings` carries `triggerSummary`, built on the server with the same text as the "When" line of the rules list: the trigger label, the schedule in words or "When someone presses Run now", followed by " · For each <one>" (or " · Summary of <plural>") when the rule loops.
