# In-app notifications

Notifications are short messages shown in the bell of the application header. They are unrelated to the mail and SMS messages composed by `internal/notifications`; the feature lives in `backend/internal/inbox` (HTTP tag _Notifications_).

## Model

- `inbox_notifications` holds the content once: `kind`, `title` (up to 120 characters), plain-text `body` (up to 2000), an optional application-relative `link` (starts with a single `/`, no backslash or whitespace; checked in the service and by a constraint), the sending account (manual messages only; set to null when the account is deleted) and `expires_at`.
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

Reading, marking and dismissing are scoped by the session's account id in every query. Sending fans out to the _enabled_ accounts of everyone holding any chosen role in the sending transaction, together with the audit event `inbox_message.sent` (changed field names only, never the text). A sender may send at most 10 messages per hour (429 `notification_rate_limited`). Recipient and read counts of the sent list leave out people who dismissed the message.

## System notifications

`inbox.Emitter` is stateless and writes inside the transaction of the mutation that causes the event, so a notification exists exactly when its trigger committed. The features that emit declare the one-method interface they need (`laborordnung`, `opendays`, `machinelogbook`) and receive `inbox.NewEmitter()` from their constructor. Recipients are resolved at emit time; an event without recipients writes nothing.

| Kind                               | Emitted when                                                                                                                                   | Recipients                                                                                                                                                    | Link                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `lab_rules_confirmation_requested` | A person's new Lab Rules confirmation request is created (an already pending request is not announced again).                                  | Enabled accounts holding `laborordnung.confirm` (master included), except the requester.                                                                      | `/settings/laborordnung`                 |
| `open_day_period_open`             | A period moves from draft to staffing (sign-up opens). Reopening a published period stays quiet.                                               | Enabled accounts of people whose roles have a staffing level (supervisor or trainee).                                                                         | `/open-days/{periodId}`                  |
| `open_day_place_freed`             | Someone leaves, or is removed from, a _supervisor_ place of a scheduled open day that starts within the next 14 days. Trainee places never do. | Enabled accounts of people with the supervisor staffing level who are not assigned to that open day, except who just left.                                    | `/open-days/{periodId}/days/{openDayId}` |
| `run_finished`                     | The machine's final report sets a recorded run's outcome (connector ingest, same transaction), or a running manual run is cancelled.           | The enabled account of the operator of the run's job. A run without a job or operator notifies nobody; a person who cancels their own manual run is not told. | `/machine-logbook/jobs/runs/{runId}`     |

A recorded run that has no job when the machine reports its end does not notify anyone, and attaching a job afterwards does not either. Manual runs have no end event (their end time is set in advance), so only cancelling one notifies.

## Frontend

- The bell is an `IconButton` with a `badgeCount` in the header next to the profile action (Carbon's `HeaderGlobalAction` has no badge). The panel is a Carbon `HeaderPanel` whose content (`NotificationList`) is lazy-loaded and fetched the first time it is opened. Clicking a notification marks it read and follows its link; each item can be dismissed and "Mark all as read" clears the badge. Nothing is stored in the browser.
- **Directory › Messages** (`/notifications/messages`, `notifications.send`) lists sent messages and opens the "New message" dialog. Choosing roles needs `roles.read` as well, because the role list is the ordinary role catalog; without it the dialog says so.
