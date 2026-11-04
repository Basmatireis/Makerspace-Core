# Guided tour progress

The application offers guided tours ("guides") to new people. Which ones an account has completed or dismissed is stored per account so a tour is not offered again on another device. The feature lives in `backend/internal/guides` (HTTP tag _Guides_, migration 00106).

## Storage

`account_guide_progress` has one row per account and guide: `guide_id` (`^[a-z][a-z0-9-]{0,63}$`), `status` (`completed` or `dismissed`) and `updated_at` (UTC, from the application clock). The primary key is `(account_id, guide_id)`; rows are deleted with the account. Guide identifiers are defined by the frontend, not by the database.

## API

| Operation                    | Notes                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /me/guides`             | Own entries, ordered by guide id. A guide without an entry has not been finished yet.     |
| `PUT /me/guides/{guideId}`   | Body `{status}`. Creates or overwrites the entry and returns it.                          |
| `DELETE /me/guides`          | Deletes every entry of the account so all tours are offered again. Answers 204.           |

All three need only a signed-in staff session (no permission) and are always scoped to the session's account; no account id is ever read from the request. `PUT` and `DELETE` need the CSRF header. A malformed guide id or status is answered with 400 by the contract validator.

Progress is a UI preference: changes write no audit event, like marking notifications read. The data category is `guides.progress` (see `privacy-and-retention.md`). When two accounts are merged, the source account's rows are deleted with it and the surviving account keeps its own.
