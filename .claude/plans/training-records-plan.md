# Training Records & Open-Day-Kompetenzen – Bestandsaufnahme und Implementierungsplan

Stand: 2026-10-23, Basis `main` @ 4bbddf70 (0.8.5). Nicht zum Committen bestimmt (AGENTS.md: keine Pläne im Repo).

## 1. Erkenntnisse aus der Codebasis

### Personen, Rollen, Berechtigungen
- Personen sind `people` (Konten optional in `accounts`). Open-Day-Einteilungen referenzieren `people.id` und funktionieren auch ohne Konto → Training Records müssen an `people(id)` hängen, nicht an `accounts`.
- Berechtigungen sind ein Code-Register (`backend/internal/authorization/permissions.go` + Enum in `api/openapi.yaml`), Rollen bekommen sie über `role_permissions`. `master` hat alles. Self/All-Muster existiert (`people.read_self` / `people.read_all`). Neue Rechte brauchen keine Migration, nur Register + OpenAPI-Enum + Frontend-Präsentation (`features/roles/permissionPresentation.ts`).
- Rollen tragen `staffing_level` (`supervisor` | `trainee`); es gibt keine Rollennamen-Logik.

### Open Days
- Tabellen: `open_day_periods` (draft/staffing/published/archived), `open_days` (scheduled/cancelled), `open_day_staff_requirements` (`kind` supervisor/trainee), `open_day_assignments` (`person_id`, `requirement_id`, `UNIQUE(open_day_id, person_id)`).
- **Einteilung = Zeile in `open_day_assignments`.** Es gibt keine Zu-/Absage-Status: Austragen (`Leave`, `RemoveAssignment`) löscht die Zeile hart. „Geplant anwesend“ heißt also: Zeile existiert und der Open Day ist `scheduled`.
- Die Einteilung unterscheidet über die Requirement zwischen **Supervisor- und Trainee-Plätzen** (siehe Entscheidung E1).
- Querverweise per SQL sind üblich: `internal/staffing/db/queries.sql` liest `open_day_*`-Tabellen direkt.

### Öffentlicher Kalender
- Es gibt **keine öffentliche Kalender-Webseite**. „Öffentlich“ sind nur:
  - `GET /api/v1/public/open-days` (JSON, `PublicOpenDay`: id, title, startsAt, endsAt, status, updatedAt; `additionalProperties: false`),
  - `GET /api/v1/public/open-days/calendar.ics` (UID, SEQUENCE = Open-Day-Version, LAST-MODIFIED/DTSTAMP = `updated_at`).
- Beide kommen aus `opendays.Service.ListPublic` / `PublicICS` (`backend/internal/opendays/calendar.go`).
- Im Frontend nutzt nur das Dashboard (`features/dashboard/queries.ts`, „nächste Open Days“) `listPublicOpenDays`. Öffentliche Seite gibt es nur für Events (`/events/public/:publicId`).

### Signage
- Signage holt Open Days über die Schnittstelle `signage.PublicCalendar` (`internal/signage/player.go`), implementiert in `internal/httpapi/signage_calendar.go` – und zwar **aus `opendays.ListPublic`**. Single Source ist damit schon gegeben.
- `signage.PublicOpenDay` enthält nur `StartsAt, EndsAt, Status` (keine ID).
- Betroffene Widgets (`internal/signage/zones.go`, Frontend `features/signage/render/`):
  - `open_days` (Liste, `listW`, mit `entryTemplate` und Platzhaltern `{date}`, `{start}`, `{status}` …),
  - `agenda` (Open Days + Events gemischt, `openDayTemplate`),
  - `calendar` (`calendarW`, Monat/Wochen, `showOpenDays`, Farben).
- Widget-Konfiguration ist Teil des Szenen-Manifests (JSON, strikt dekodiert). Neue optionale Felder sind abwärtskompatibel, wenn „fehlt“ = alter Zustand. Es gibt `manifest_compat_test.go`.
- Live-Daten: `/signage/player/live` alle ~10 s (`openDays` ≤ 20) und `calendar`-Block (≤ 100 Open Days).

### Maschinen
- `machine_types` (mit `process`: fdm_printing, laser_cutting, embroidery, uv_printing, vinyl_cutting, other) und `machines` (Instanzen, `machine_type_id`, Status active/maintenance/retired). Schulungen sind fachlich modellbezogen („Bambu Lab H2D“) → passt zu `machine_types` (Entscheidung E3).
- `process` ist ein festes Enum für Run-Erfassung/Preise, **keine** pflegbare öffentliche Kategorie – als Kompetenzkategorie ungeeignet (Elektronik/Löten hat keine Maschine).

### Bestehende Schulungs-/Skill-Modelle
- Keine. Gesucht nach training/qualif/competen/skill/einschul/unterwies: kein Treffer. Laborordnung (`laborordnung`) ist eine Unterschrift, kein Befähigungsmodell. Es wird nichts verdoppelt.

### Audit, Konfigurationstransfer, Einstellungen
- `audit_events` (action, resource_type, resource_id, changed_fields, metadata jsonb) in derselben Transaktion – wird wiederverwendet, keine eigene Historientabelle.
- `configtransfer` exportiert Rollen, Maschinen, Preise. Schulungsdefinitionen und Kategorien sind Konfiguration und passen dorthin (Training Records sind personenbezogen → **nicht** exportieren).
- Einstellungen: `features/settings/settingsCatalog.ts`, Gruppe „Lab operations“.

## 2. Konflikte und Abweichungen zum Architekturdokument

| # | Dokument nimmt an | Realität | Vorschlag |
|---|---|---|---|
| K1 | Es gibt eine öffentliche Kalender-UI | Nur JSON + ICS; einzige Anzeige ist das (angemeldete) Dashboard | JSON/ICS erweitern, Dashboard-Liste und Signage zeigen Kompetenzen; **keine** neue öffentliche Seite (AGENTS.md: keine Platzhalterseiten). Filter (P1) entfällt mangels UI. |
| K2 | „Betreuer“ eindeutig | Einteilung hat Supervisor- und Trainee-Plätze | E1 |
| K3 | Zu-/Absagen | Keine Status, Austragen löscht | Nur bestehende Zeilen auf `scheduled` Open Days zählen; abgesagte Open Days liefern leere Liste |
| K4 | ICS konsistent mit Web | SEQUENCE/LAST-MODIFIED hängen an `open_days.version/updated_at`; Kompetenzen ändern sich durch Einteilungen und Records, ohne dass der Open Day sich ändert | E4 |
| K5 | `PublicOpenDay` beliebig erweiterbar | `additionalProperties: false`, generierter Client | Additives Pflichtfeld `competencies: []` im Contract; Clients werden neu generiert. Externe Konsumenten sehen ein neues Feld – das ist additiv. |
| K6 | `machine_ids` | Schulung ist modellbezogen, Maschinen sind Instanzen | E3 |
| K7 | Signage hat „Open-Day-Liste“ und „Calendar“ | Zusätzlich `agenda` mit Open Days | `agenda` gleich mitbehandeln, sonst inkonsistent |
| K8 | Dokument-Pfade `/internal/...` | API hat `/api/v1/...` mit Feature-Pfaden | Projektkonvention übernehmen (siehe 3.3) |
| K9 | Leak-Risiko „klein“ | Bei nur einem eingeteilten Supervisor verrät die Kompetenzliste dessen Qualifikation an jeden, der die Einteilung kennt | Akzeptabel: Namen sind öffentlich nicht sichtbar, intern sehen Namen nur Rechteinhaber von `open_days.read_assignments`. Im Doku-Abschnitt festhalten. |

## 3. Notwendige Änderungen

### 3.1 Datenmodell (eine Migration `00067_training_records.sql`)

```sql
CREATE TABLE competency_categories (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (name = btrim(name) AND name <> '' AND length(name) <= 120), -- öffentliches Label
    description text CHECK (description IS NULL OR length(description) <= 2000),          -- intern
    active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX competency_categories_name_ci_idx ON competency_categories (lower(name));

CREATE TABLE trainings (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (...<= 150),
    description text CHECK (...<= 2000),
    active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    version, created_at, updated_at
);
CREATE UNIQUE INDEX trainings_name_ci_idx ON trainings (lower(name));

CREATE TABLE training_competencies (
    training_id uuid NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
    competency_id uuid NOT NULL REFERENCES competency_categories(id) ON DELETE CASCADE,
    PRIMARY KEY (training_id, competency_id)
);
CREATE TABLE training_machine_types (
    training_id uuid NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
    machine_type_id uuid NOT NULL REFERENCES machine_types(id) ON DELETE CASCADE,
    PRIMARY KEY (training_id, machine_type_id)
);

CREATE TABLE training_records (
    person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,   -- Hard-Delete der Person bleibt echt
    training_id uuid NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('trained', 'trainer')),
    completed_on date,
    notes text CHECK (notes IS NULL OR length(notes) <= 2000),
    recorded_by_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
    version bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, training_id)
);
CREATE INDEX training_records_training_idx ON training_records (training_id, person_id);
```

- `not_trained` = **kein Datensatz** (keine Zeilen-Explosion, „auf nicht geschult setzen“ löscht die Zeile; der Wechsel steht im Audit). `trainer ⊃ trained` ist durch ein einziges Enum erzwungen.
- Kein Feld in `open_days` – Kompetenzen werden immer beim Lesen berechnet (kein Cache, keine Invalidierung nötig).
- Löschen: Schulungen/Kategorien nur deaktivierbar über die UI; hartes Löschen nur, wenn keine Records/Zuordnungen existieren (Muster wie bei Maschinen-Katalog).

### 3.2 Backend-Modul `internal/trainings`

- `db/queries.sql` (sqlc), `types.go`, `service.go`, `competencies.go`, `doc.go`.
- Service: CRUD für Kategorien und Schulungen (inkl. Links, Versionsprüfung), `ListPersonRecords`, `SetRecord` (Upsert bzw. Delete bei `not_trained`), jeweils mit Audit-Event in derselben Transaktion (`training_record.updated`, Metadata: `training_id`, `old_status`, `new_status`; **keine** Notizen).
- **Zentraler Resolver** (einzige Stelle der Ableitung):

```sql
-- name: ListOpenDayCompetencies :many
SELECT DISTINCT a.open_day_id, c.id, c.name, c.sort_order, lower(c.name) AS sort_name
FROM open_day_assignments a
JOIN open_days d ON d.id = a.open_day_id AND d.status = 'scheduled'
JOIN open_day_staff_requirements r ON r.id = a.requirement_id   -- Filter je nach E1
JOIN training_records tr ON tr.person_id = a.person_id          -- trained + trainer
JOIN trainings t ON t.id = tr.training_id AND t.active
JOIN training_competencies tc ON tc.training_id = t.id
JOIN competency_categories c ON c.id = tc.competency_id AND c.active
WHERE a.open_day_id = ANY(sqlc.arg(open_day_ids)::uuid[])
ORDER BY a.open_day_id, c.sort_order, sort_name, c.id;
```

  Go-Funktion `trainings.OpenDayCompetencies(ctx, db, ids) (map[uuid.UUID][]Competency, error)`; `Competency{ID, Label}`. `opendays` importiert `trainings` (eine Richtung, kein Zyklus). Set-basiert → eine Query pro Liste, auch für Signage-Polling unkritisch.
- `opendays`: `PublicOpenDay` und internes `OpenDay` bekommen `Competencies []trainings.Competency`. `ListPublic` ruft den Resolver für alle gelieferten Tage; `PublicICS` schreibt (je nach E4) eine Zeile „Voraussichtliche Unterstützung: 3D-Druck, Lasercutter“ in `DESCRIPTION`.
- `httpapi/signage_calendar.go`: `signage.PublicOpenDay` um `Competencies []string` (nur Labels) erweitern, Mapping in `publicOpenDay`.
- Neue Berechtigungen (Register + OpenAPI + Präsentation + Tests):
  - `trainings.manage` – Schulungen und Kategorien pflegen,
  - `training_records.read_self` – eigene Schulungen sehen,
  - `training_records.read_all` – Schulungen aller Personen sehen (inkl. interner Notizen),
  - `training_records.update` – Status anderer Personen setzen (nie auf sich selbst? → E5).
  - Die abgeleiteten Open-Day-Kompetenzen brauchen **kein** neues Recht (gleiche Sichtbarkeit wie der Open Day selbst).
- `configtransfer`: neuer Abschnitt „Trainings & competencies“ (Definitionen, Kategorien, Links; Maschinentypen per Name). Keine Records.

### 3.3 API (`api/openapi.yaml`, dann `make generate`)

| Methode/Pfad | Recht |
|---|---|
| `GET /competency-categories` | `trainings.manage` oder `training_records.read_*` |
| `POST /competency-categories`, `PATCH/DELETE /competency-categories/{id}` | `trainings.manage` |
| `GET /trainings` (inkl. Kategorie- und Maschinentyp-IDs) | wie oben |
| `POST /trainings`, `PATCH/DELETE /trainings/{id}` | `trainings.manage` |
| `GET /people/{personId}/training-records` (alle aktiven Schulungen + Status, fehlend = `not_trained`) | `read_self` für sich, sonst `read_all` |
| `PUT /people/{personId}/training-records/{trainingId}` (`{status, completedOn?, notes?, version?}`) | `training_records.update` |
| `GET /me/training-records` (optional, Profil) | `read_self` |
| Erweiterung `OpenDay` (intern): `competencies: [{id, label}]` | wie bisher `open_days.read` |
| Erweiterung `PublicOpenDay`: `competencies: [{id, label}]` | öffentlich (security bleibt im Contract) |
| Erweiterung Signage-Live/Calendar `openDays[].competencies: [string]` | Player-Credential |

Öffentlich ausgegeben werden ausschließlich Kategorie-ID und Label. Keine Personen-, Trainings- oder Statusfelder.

### 3.4 Frontend (Carbon v11)

- **Personendetail** (`features/users/detail/TrainingRecordsSection.tsx`, im `UserDetailPage`): `StructuredList`/`DataTable` aller aktiven Schulungen; pro Zeile ein **`RadioButtonGroup`** (oder `ContentSwitcher`) „Nicht geschult / Geschult / Darf selbst schulen“, optional `DatePicker` + Notiz in einem Edit-`Modal`. Nur mit `training_records.update` editierbar, sonst `Tag`-Anzeige. Inaktive Schulungen mit vorhandenem Record werden ausgegraut gelistet.
- **Profil** (`features/profile/ProfilePage.tsx`): eigene Schulungen read-only.
- **Verwaltung**: Settings › Lab operations › „Trainings & competencies“ (`/settings/trainings`, `trainings.manage`), zwei Tabs (`Tabs`): Schulungen (`DataTable`, Modal mit `TextInput`, `TextArea`, `MultiSelect`/`FilterableMultiSelect` für Kategorien und Maschinentypen, `Toggle` aktiv) und Kategorien (Sortierung per `NumberInput` oder Hoch/Runter-Buttons, `Toggle` aktiv). Route lazy laden.
- **Open-Day-Detail** (`features/opendays/OpenDayDetailPage.tsx`): Abschnitt „Planned competencies“ mit `Tag`s; Leerzustand „No trained supervisor assigned yet“. Nach Join/Assign/Remove invalidiert die bestehende Query den Tag → automatische Aktualisierung.
- **Dashboard**: „Next open days“ zeigt die Kompetenz-`Tag`s aus der Public-Liste.
- **Signage**:
  - Neues optionales Feld `showCompetencies` (fehlt = `false`) auf `open_days`, `agenda` und `calendar`; Editor-`Checkbox` in `ListFields.tsx` / `CalendarFields.tsx`.
  - Neuer Platzhalter `{competencies}` (kommagetrennt, escaped) für `entryTemplate`/`openDayTemplate` – Templates brauchen kein Flag.
  - Standardzeile (ohne Template) und Kalender: Chips, max. N (Liste 4, Kalender-Wochenansicht 2, Monatsansicht nur „+X“/keine) und „+X“; CSS in `render/render.css`, hoher Kontrast.
  - Admin-Vorschau (`GET /signage/calendar`) und `testFixtures.ts` erweitern.
- Generierte Clients neu erzeugen; MSW-/e2e-Mocks (Memory: neue Endpunkte brauchen den e2e-Mock).
- Bundle-Budget nach Build messen (keine neuen Abhängigkeiten nötig; Carbon-Sass-Module für `RadioButtonGroup`, `Tabs` ggf. ergänzen).

### 3.5 Dokumentation
- Neu: `docs/trainings.md` (Modell, Rechte, Ableitungsregel, Datenschutzgrenze).
- Anpassen: `docs/open-days.md` (Abschnitt „Public privacy“: Kompetenzlabels), `docs/signage.md` (Widget-Felder, Platzhalter, Live-Daten), `docs/authorization.md` (neue Rechte), `docs/configuration-transfer.md`, `CHANGELOG.md`.

## 4. Implementierungsplan (Phasen, je ein Commit)

1. **Schema + Modul-Gerüst**: Migration, sqlc-Queries, `internal/trainings` mit Kategorien/Schulungen-CRUD und Audit; Berechtigungen registrieren. Tests: Repository/Service gegen echtes PostgreSQL, Rechte (403 ohne `trainings.manage`).
2. **Training Records**: `GET/PUT` pro Person, Self/All-Scope, Löschen bei `not_trained`, Audit ohne Notizen. Tests: Statusvalidierung (nur drei Werte), Self vs. All, fremde Person ohne Recht → 403 auch per direktem API-Aufruf, Personen-Hard-Delete löscht Records.
3. **Resolver + Open Days**: `OpenDayCompetencies`, Einbau in internes `OpenDay`, `ListPublic`, ICS. Tests: alle zehn Grenzfälle aus Abschnitt 7 des Konzepts (Dedup, trainer = trained, fehlender Record, Austragen, Kategoriezuordnung ändern, inaktive Schulung/Kategorie, abgesagter Tag, Trainee-Regel nach E1) und ein **Public-Snapshot-Test**, der prüft, dass JSON/ICS nur `{id,label}` enthalten (keine Person-/Trainings-IDs, kein `trainer`).
4. **Signage-Backend**: `PublicOpenDay.Competencies`, Widget-Felder `showCompetencies`, Validierung, Kompatibilitätstest (alte Manifeste unverändert gültig).
5. **Interne UI**: Personendetail, Profil, Settings-Verwaltung, Open-Day-Detail, Dashboard-Liste. Tests (Vitest/RTL): drei Zustände, Leserechte ohne Schreibrechte, Leerzustände.
6. **Signage-UI**: Editorfelder, Platzhalter, Chips mit „+X“, Vorschau. Tests: 0/1/viele/lange Labels, schmale Zonen, Layouts ohne Option unverändert (Snapshot).
7. **Konfigurationstransfer + Doku + Messung**: configtransfer-Abschnitt, Doku, `make lint test build`, Bundle messen, Desktop- und Schmalansicht prüfen.

P1 später: Qualifikationsmatrix (Personen × Schulungen) unter People, Kompetenzen der wählbaren Personen im „Assign“-Dialog, Kompetenzen in der Semester-Kalenderansicht. P2: Open-Day-Ausschlüsse, Maschinenstatus-Abgleich.

## 5. Offene Entscheidungen

- **E1 – Zählen Trainees?** Empfehlung: **nur Supervisor-Plätze** zählen (Trainees sind im ersten Semester; „Betreuer“ = Supervisor, wie bei der Unterbesetzungs-Warnung). Alternative: alle Eingeteilten.
- **E2 – Inaktive Schulung/Kategorie:** Empfehlung: Records bleiben erhalten, zählen aber **nicht** mehr für Kompetenzen; neue Records sind nicht möglich. Reaktivieren stellt alles wieder her.
- **E3 – Maschinenbezug:** Empfehlung: Verknüpfung mit **Maschinentypen** statt einzelnen Maschinen (rein informativ im MVP).
- **E4 – ICS:** Empfehlung: Kompetenzen in `DESCRIPTION` aufnehmen, `DTSTAMP` = Erzeugungszeitpunkt des Feeds (RFC-5545-konform), `LAST-MODIFIED`/`SEQUENCE` bleiben an der Open-Day-Version (eine geänderte Beschreibung ist laut RFC keine Terminänderung). Alternative: ICS im MVP ohne Kompetenzen.
- **E5 – Wer darf Records setzen?** Empfehlung: nur `training_records.update` (z. B. Leitung); Trainer erhalten im MVP **kein** automatisches Recht (Berechtigungsautomation ist P2). Selbst-Änderung des eigenen Status verbieten.
- **E6 – Sprache der UI-Texte:** Die App ist englisch („Planned competencies“, „Not trained / Trained / Can train others“); Kategorielabels pflegt die Leitung frei (z. B. deutsch).
