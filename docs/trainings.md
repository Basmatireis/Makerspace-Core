# Training records and open-day competencies

Training records say who completed which training. Open days derive from them which areas of support the assigned supervisors bring, and show these publicly as competencies, without ever saying who brings them or who may train others.

## Model

- **Competency** (`competency_categories`): what may be shown publicly, for example "3D printing" or "Laser cutting". Its name is the public label. It has an internal description, a sort order and an active flag.
- **Training** (`trainings`): an internal course type, for example "Bambu Lab H2D – operation". It feeds one or more competencies (`training_competencies`) and may name the machine types it covers (`training_machine_types`, informational only). It has a description, a sort order and an active flag.
- **Training record** (`training_records`, one per person and training): `trained` or `trainer`, with an optional completion date and internal notes. **Not trained is the absence of a record**; the API reports it as `not_trained`. `trainer` includes `trained`: the person completed the training and may give it. Records hang on people, so people without accounts can hold them, and hard-deleting a person deletes their records.

Schema: migration 00071.

## Rules

- **Deactivating** a training or competency keeps its records and links, but it no longer counts for open days. An inactive training takes no new status: its records can only be removed or have their date and notes corrected (409 `training_inactive`). Reactivating restores everything.
- **Deleting** is only possible while nothing uses the entry: a training nobody holds a record of (else 409 `training_in_use`), a competency no training feeds (else 409 `competency_category_in_use`).
- **Nobody changes their own status**, not even the master (403 `training_record_self`). Trainers get no automatic right to record trainings; that needs `training_records.update`.
- Every status change writes an audit event in the same transaction: `training_record.trained`, `.trainer`, `.updated` (only date or notes changed) or `.removed`, with resource type `training_record`, the person as resource and `personId`/`trainingId` as metadata. Notes and dates are never copied into the audit.

## Permissions

| Permission                   | Allows                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `trainings.manage`           | Create, edit, deactivate and delete trainings and competencies.                             |
| `training_records.read.self` | Read the own training status, without internal notes. Also reads the training catalogue.    |
| `training_records.read.all`  | Read everybody's training status with internal notes. Also reads the training catalogue.    |
| `training_records.update`    | Set another person's status; also reads everybody's records, because the editor needs them. |

The derived open-day competencies need no extra permission: they are visible wherever the open day is.

## Open-day competencies

`trainings.OpenDayCompetencies` is the single place of the rule. For each open day it takes the people in **supervisor** places (trainee places do not count), their records with `trained` or `trainer` for **active** trainings, and the **active** competencies those trainings feed; the result is deduplicated and ordered by sort order, then label. Cancelled open days and open days without a qualified supervisor get an empty list. Nothing is stored on the open day: assignment changes, record changes and changes to trainings or competencies show at the next read.

The competencies are planned support, not a guarantee: the assignment can still change, and a competency says nothing about whether a particular machine works.

| Where                                         | What                                                                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /open-days/{id}`, the period schedule    | `competencies: [{id, label}]`; the open-day page shows "Planned support".                                                                                                                                                                     |
| `GET /public/open-days`                       | `competencies: [{id, label}]` per open day of a published period.                                                                                                                                                                             |
| `GET /public/open-days/calendar.ics`          | `DESCRIPTION:Planned support: 3D printing, Laser cutting` when there are any. `DTSTAMP` is the feed's generation time; `LAST-MODIFIED` and `SEQUENCE` stay on the open day's own version, because a description change is not a rescheduling. |
| Signage live data and `GET /signage/calendar` | `openDays[].competencies: [label]` (see [signage.md](signage.md)).                                                                                                                                                                            |
| Dashboard                                     | The next open days show the competency tags.                                                                                                                                                                                                  |

Public output never contains people, training names or IDs, notes, or whether someone is a trainer. Integration tests assert this for JSON, ICS and signage. When only one supervisor is assigned, the competencies of a day reflect that person's trainings; the public cannot tell who that is, and inside the app only people with `open_days.read_assignments` see the names.

## API

- `GET /competency-categories`, `POST /competency-categories`, `PATCH`/`DELETE /competency-categories/{id}`
- `GET /trainings`, `POST /trainings`, `PATCH`/`DELETE /trainings/{id}` (`PATCH` replaces both link lists)
- `GET /people/{personId}/training-records`: every active training plus inactive ones the person holds a record of.
- `PUT /people/{personId}/training-records/{trainingId}`: `{status, completedOn?, notes?, expectedVersion?}`. Send the record's `version` as `expectedVersion`, or omit it when the person had no record; a mismatch answers 409 `stale_write`. `not_trained` deletes the record and takes no date or notes.

## User interface

- **People › person › Trainings**: status per training. With `training_records.update` an edit button opens a dialog with the three-state choice (Not trained / Trained / Can train others), completion date and internal notes. The button never appears on the own person.
- **Profile**: the own trainings, read-only, with `training_records.read.self`.
- **Settings › Lab operations › Trainings & competencies** (`trainings.manage`): the trainings with their competencies and machine types, and the competencies with public label, sort order and active flag.

## Configuration transfer

Trainings and competencies are part of export and import (sections `competencies` and `trainings`, see [configuration-transfer.md](configuration-transfer.md)). Training records are personal data and never exported.

## Later

Not part of this version: open-day exclusions (a competency is not offered although someone qualified is assigned), comparing with machine status, expiry dates, course organisation, and granting rights from trainer status.
