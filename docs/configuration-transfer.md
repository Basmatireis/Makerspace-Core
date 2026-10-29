# Configuration export and import

Settings › Export & import moves the configuration of one makerspace instance to another (or back into the same one) as a JSON file. The backend lives in `backend/internal/configtransfer`; the screen in `frontend/src/features/configtransfer`.

## Permissions

| Operation                   | Needs                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------- |
| Export                      | `configuration.export` and the read permission of every chosen section                 |
| Preview and apply an import | `configuration.import` and the read **and** manage permissions of every chosen section |

Every write goes through the owning feature service (`*Tx` variants of the ordinary service methods), so the import enforces exactly the rules of the UI: a role editor can only create or change roles whose grants it could delegate itself (privilege-subset rule), the system role `master` is never exported, imported, changed or deleted, a visitor-enrollment initial role must be assignable by the actor, and so on. A refusal of a service becomes a **conflict** of that entry.

## Sections and natural keys

Entries are matched by natural key, never by ID; names compare case-insensitively. References between sections are resolved by name against the target instance at import time, after the earlier sections of the same import were applied (sections are imported in the order below).

| Key                   | Content                                                                                                                                                                                                                       | Natural key                                                                        | References                           | Missing from the file (overwrite)                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `deviceTypes`         | Managed device types (not devices or credentials)                                                                                                                                                                             | name                                                                               | –                                    | deleted; kept when devices, role grants or visitor enrollment use it                               |
| `sessionPolicies`     | Session policies                                                                                                                                                                                                              | name                                                                               | –                                    | kept (no delete path)                                                                              |
| `roles`               | Configurable roles with behaviors and permission grants                                                                                                                                                                       | name                                                                               | device types                         | deleted; kept when assigned to people or used by visitor enrollment or staffing requirements       |
| `machineTypes`        | Machine types and their process                                                                                                                                                                                               | name                                                                               | –                                    | deactivated (no delete path)                                                                       |
| `competencies`        | Public competency labels with description, sort order and active flag                                                                                                                                                         | name                                                                               | –                                    | deleted; deactivated when trainings feed it                                                        |
| `trainings`           | Trainings with their competencies and machine types (no training records)                                                                                                                                                     | name                                                                               | competencies, machine types          | deleted; deactivated when people hold records of it                                                |
| `materialTypes`       | Material types (kind, unit, processes)                                                                                                                                                                                        | name                                                                               | –                                    | deleted; deactivated when articles or pricing rules use it                                         |
| `machines`            | Machines with status, external identifier and printer setup (model, input units, slots)                                                                                                                                       | name; units and slots by name                                                      | machine type                         | deleted; retired when the machine has jobs, runs, connector assignments, cameras or mounted spools |
| `inventoryArticles`   | Article definitions (no stock, ledger, spools or fills)                                                                                                                                                                       | name                                                                               | material type                        | deleted; deactivated when the article has stock history                                            |
| `pricing`             | Pricing groups with their active rules, and the role → pricing group mapping                                                                                                                                                  | group name; rule by kind + machine type / material type + measure; mapping by role | roles, machine types, material types | groups and rules deactivated; mapping replaced                                                     |
| `openDayRequirements` | Open days per semester, trainee promotion, supervisor role                                                                                                                                                                    | single record                                                                      | role                                 | –                                                                                                  |
| `visitorEnrollment`   | Enabled flag, initial role, methods, device types                                                                                                                                                                             | single record                                                                      | role, device types                   | –                                                                                                  |
| `branding`            | Identity (incl. the playful dashboard greetings and their share), colors, imprint and privacy, the five asset slots (custom assets as base64); an export without the greeting fields keeps the importing instance's greetings | single record; assets by slot                                                      | –                                    | –                                                                                                  |
| `labRules`            | The Lab Rules version in force and later published versions, with their PDF (base64)                                                                                                                                          | revision                                                                           | –                                    | kept: versions are immutable evidence                                                              |
| `surveys`             | Definitions of draft and published surveys and their post-visit trigger timing (never responses or invitations)                                                                                                               | name                                                                               | –                                    | published surveys are closed, others kept                                                          |
| `mail`                | SMTP host, port, TLS mode, username, sender, base URL (never the password)                                                                                                                                                    | single record                                                                      | –                                    | –                                                                                                  |
| `invoicing`           | wiRef delivery: enabled, recipient, CC list, reply-to, mail and PDF templates, field toggles                                                                                                                                  | single record                                                                      | –                                    | –                                                                                                  |
| `privacy`             | Controller name, address and contact; one retention decision per data category; the record of processing activities                                                                                                           | settings: single record; decision by category; activity by name                    | data categories (declared in code)   | decisions kept; activities deleted                                                                 |

Not part of any section: people, accounts, credentials, sessions, jobs, runs, orders, payments, stock, spools, printer connectors, signage, events, open-day calendars, OIDC providers, SCIM connectors, retention holds and runs, data-subject requests and the switch for automatic retention runs.

## Modes

- **Insert** creates only entries whose key does not exist; everything that exists stays untouched (including child entries such as the rules of an existing pricing group). Single-record sections (open-day requirements, visitor enrollment, branding, mail, invoice delivery) always exist and are skipped.
- **Overwrite** makes each chosen section equal the file: matching entries are updated, missing ones created, and entries not in the file deleted. An entry that is still referenced is deactivated when the entity supports it, otherwise kept; both are listed in the report with a reason. Only fields that differ are written, so unchanged entries cause no audit events or side effects (updating a session policy signs out its sessions).

Notes:

- A file without a default session policy or default pricing group leaves the current default unchanged.
- Imported surveys are drafts with a disabled trigger; publish them deliberately. A published or closed survey whose definition differs is kept with its definition (published surveys are immutable).
- A machine without `printer` keeps any printer setup it has. Units and slots of the file are matched to existing ones by name, so mount history stays attached; removed units are disabled and removed slots retired like in the printer setup editor.
- Lab Rules versions are created and published with their original effective time. A version with the same revision and a different PDF is a conflict in overwrite mode.
- Invoicing: export and import need `invoicing.settings.manage`. Mail and PDF templates are checked with the same placeholder validation as the settings endpoint; an invalid template or address refuses the file or the entry.
- Privacy: export needs `privacy.read` and `privacy.policies.manage`, import additionally `privacy.settings.manage`. A retention decision travels as its content (trigger, period, action, purpose, legal basis, reason) without its status or approvals: the import updates the target's draft for the category, or adds the file's decision as a new draft next to an approved or active version, which stays in force. The import never approves or activates, so each instance keeps its four-eyes rule and audit trail; decisions missing from the file are kept. The seeded drafts exist on both sides before a transfer. Processing activities are matched by name; one that names a category the target does not declare is a conflict.
- Mail: the SMTP password never leaves an instance. When the import changes the host, port, TLS mode or username, a stored password is dropped so it is never sent to a server it was not entered for. Delivery stays disabled until a password is entered when a username is set, and when application encryption keys are missing.

## Preview, apply and conflicts

1. `POST /configuration-transfer/import/preview?mode=…&sections=…` with the file as `application/octet-stream` body runs the complete import in a **serializable** transaction that is always rolled back and returns a report: per section the counts of `create`, `update`, `delete`, `deactivate`, `keep`, `skip` and `conflict`, the entries with reasons, warnings, and a **fingerprint** (SHA-256 of the canonical export of the chosen sections, stored files by their digest).
2. `POST /configuration-transfer/import/apply?mode=…&sections=…&fingerprint=…` runs the same import in one serializable transaction. It answers 409 `configuration_changed` when the fingerprint no longer matches (or a concurrent change causes a serialization failure) and 409 `configuration_import_conflicts` when any entry conflicts; then nothing is changed. Every entry's write runs in a savepoint so the preview can report all conflicts at once.

The services write their usual audit events; the import adds one `configuration.section_overwritten` or `configuration.section_inserted` event per section (changed field: the section key). Exports are audited as `configuration.exported` with the section keys. Custom branding assets and Lab Rules PDFs are stored inside the transaction and removed again when it does not commit; replaced branding files are deleted after commit.

## File format

```json
{
  "format": "makerspace-core-config",
  "version": 1,
  "appVersion": "v0.8.3",
  "exportedAt": "2026-10-21T08:00:00Z",
  "sections": {
    "roles": [
      {
        "name": "Supervisor",
        "description": null,
        "profileImageRequired": false,
        "labRulesMode": "warning",
        "staffingLevel": "supervisor",
        "minOpenDaysPerSemester": 1,
        "permissions": [
          {
            "permission": "open_days.read",
            "scope": "global",
            "minimumAssurance": "low",
            "deviceTypes": []
          }
        ]
      }
    ],
    "...": "one entry per exported section"
  }
}
```

- A role's `minOpenDaysPerSemester` (`null` = the general minimum) is only valid together with a `staffingLevel`. Files exported before the field existed lack it and still import; an overwrite import then resets the role to the general minimum.
- The file is indented JSON with stable ordering (entries sorted by natural key), so two exports of the same state differ only in `exportedAt`.
- Decimals (rates, prices, thresholds, diameters) are strings; timestamps are RFC 3339 UTC; file content is standard base64 next to its lowercase hex `sha256`, which the import verifies.
- Validation is strict: at most 64 MiB (`configtransfer.MaxFileBytes`, also the export limit), `format` and `version` must match, chosen sections must be present, unknown fields and duplicate names (ignoring case) are rejected with 422 `configuration_file_invalid` naming the section. Unknown sections (from a newer release) are ignored with a warning.

## Adding a section

Write a `define(...)` call in `backend/internal/configtransfer` with the section's read/manage permissions, exporter (reads through `configtransfer/db/queries.sql`), validator and importer (writes through the owning service's `*Tx` methods, each entry through `run.attempt`), list it in `registry` after the sections it references, add the key to `ConfigurationSection` in `api/openapi.yaml`, add its label and permissions to `frontend/src/features/configtransfer/sections.ts`, and extend the round-trip test in `service_test.go`.
