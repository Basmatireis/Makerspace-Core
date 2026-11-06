# Personal calendar subscription

Every signed-in person can subscribe to their own commitments in a calendar application: the open-day timeslots they hold and the event shifts they signed up for.

## Endpoints

| Endpoint                        | Access        | Behaviour                                                                                                                                                                  |
| ------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/calendar-feed`         | staff session | `{active, createdAt, lastUsedAt}`. Never the link.                                                                                                                         |
| `POST /me/calendar-feed`        | staff session | Creates the subscription or rotates it (the old link stops working at once) and returns `{url, createdAt}`. The link is shown only here. Audit `calendar_feed.created` / `calendar_feed.rotated`. |
| `DELETE /me/calendar-feed`      | staff session | Revokes it. Audit `calendar_feed.revoked`; without a subscription nothing happens.                                                                                          |
| `GET /calendar/{token}.ics`     | the token     | `text/calendar`, `Cache-Control: no-store`, rate limited per source address (120 per minute). Unknown, revoked and inactive links answer `404`.                              |

## Storage and privacy

`calendar_feeds` (migration 00111) holds one row per person: the SHA-256 digest of the token (unique), `created_at` and `last_used_at`, which is refreshed at most once an hour. The token itself is never stored or logged (request logs carry the route template, not the path). The row is deleted with the person; a person whose account is not enabled has no feed until it is enabled again. The data category is `calendar.feeds`; the data export of a person lists existence and dates only.

## Content

From 30 days back on, without an upper bound:

- one event per held open-day timeslot: `SUMMARY` "Open day · Supervisor" or "Open day · Trainee", `UID` the timeslot id, `SEQUENCE` the open day's version, `STATUS:CANCELLED` for a cancelled day;
- one event per active event shift sign-up of non-draft events: `SUMMARY` "event name · shift name", `LOCATION` of the session or event when known, `UID` the shift id, `SEQUENCE` the sum of shift and event versions, `STATUS:CANCELLED` when the shift or event is cancelled.

The feed names no other person.
