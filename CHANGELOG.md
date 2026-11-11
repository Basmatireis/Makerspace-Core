# Changelog

Notable changes to Makerspace Core are documented here. Releases follow Semantic Versioning.

## [Unreleased]

### Added

- **Signage web embeds.** A signage screen can be shown in an iframe on other websites: it lists the websites that may frame it, shows only public information, and shows cameras and timelapses only when switched on for it. Embeds are managed under `/signage/web-embeds` with the existing signage permissions and served by public endpoints under `/public/signage/embeds/{embedKey}` (migration 00130). See `docs/signage.md`.
- **Signage screen editor.** A screen (formerly scene) is a set of freely positioned blocks on a fixed grid, each with one widget and its own box style. The new editor (Signage › Screens) has a canvas with snapping, a palette, a block list, toolbars and properties panels, autosaves drafts, offers undo and redo and has no Save button. Layout templates, zones and custom layouts are gone: migration 00131 converts every stored screen (and, in memory, older publications) so displays look as before and nothing becomes a pending change. Manifests are version 4: players refetch cached older ones. The player bundles the IBM Plex fonts and its service worker precaches them; image and video pickers can upload in place. See [docs/signage.md](docs/signage.md).
- **Signage colours.** Machine status, camera, timelapse, open-day/event/agenda lists and QR codes have their own optional colours (also transparent); absent colours keep the previous look. The Screen section lists every colour used on a screen and changes it everywhere at once. Calendar widgets can hide their legend and show planned competencies in the month view too. See [docs/signage.md](docs/signage.md).

- **Sign-in with an emailed code.** Accounts can sign in on the web login page and check in or out at a kiosk with a six-digit code mailed to their login email (`/auth/email-code`, `/auth/email-code/login`, `/terminal/email-code`, `/terminal/check-in/email-code`, `/terminal/check-out/email-code`). People switch it on and off under their security settings (`accounts.email_code.manage.self`), administrators per account (`accounts.email_code.manage.all`) and can mail someone a code (`POST /accounts/{id}/email-code/send`). Kiosk code requests are limited per device. See `docs/authentication.md`.

### Changed

- **Visitor enrollment verifies the email address.** Visitors enter their address, receive a code and confirm it (`/visitor-enrollment/email-verification` and `/confirm`) and then sign in with emailed codes only. The PIN/password choice, the login-name suggestions endpoint, `allowedMethods` in the enrollment configuration and state (and in configuration exports; older files are still accepted), the submission's `email`/`authMethods`/`pinLoginName`/`pin` and the result's `invitationDelivery` are gone, and no invitation is mailed.

### Upgrade notes

- **Migration 00132 (emailed sign-in code).** Existing visitors (Visitor membership, not master) are switched to the emailed code: their passwords, pending invitations, reset codes and password sessions are removed; PINs stay. Grants of `accounts.pin.enroll.self`/`.all` are copied to the new email-code permissions. The Down migration cannot restore removed passwords.
- **Migrations 00130 (signage web embeds) and 00131 (signage scene blocks).** 00131 converts every stored scene into blocks; see `docs/signage.md`.

## [0.18.2] - 2026-11-10

### Added

- **Membership roles.** Every person is a Supervisor, Trainee or Visitor (system roles with fixed names; their permissions stay editable). New people start as Visitor whichever way they are created. The Leitung changes the membership on the staffing page; becoming a Visitor frees the person's upcoming open days.
- **Staffing rules.** One place (People › Staffing › Rules) for the minimum per semester of supervisors and trainees, the trainee ready-after count, the warning window (default 14 days), whether timeslots or open days count, the default sign-up deadline and exceptions per extra role. The Leitung can excuse a person from the minimum of a semester with a reason that only dashboard readers see.
- **Timeslots and weekly series.** An open day has one or more timeslots, each with its own supervisor and trainee places, and places can be restricted to extra roles. Weekly series create the days of a period, can be edited from a date on, and a day edited on its own leaves its series and can rejoin it. Overlapping open days are refused. A new period can copy the series of an earlier one.
- **Rebuilt Open Days and Staffing pages.** Periods, breaks and the schedule (Upcoming, Short-staffed, Open for me, Mine, Past; list or calendar) with a fixed detail panel, a working copy with a save bar, and a Filters button with a red count. Staffing has a sortable, filterable People table with CSV export, a person panel (assign, remove, confirm Lab Rules, change membership, excuse) and the Rules tab.
- **Training filter.** The staffing table filters and searches by the competency categories of a person's training records; `GET /supervisor-dashboard` rows carry them as `competencies`.
- **Personal calendar subscription.** A secret link (profile menu › Calendar subscription) shows a person's open-day timeslots and event shifts in any calendar application; see `docs/calendar-feed.md`.
- **Profile images on open days.** The place dots show the assigned people's profile images (initials when there is none) to everyone who sees their names; your own place is green.
- **Notices for schedule changes.** People are notified (in the app and by e-mail while mail delivery is on) when a timeslot they hold changes, is removed or the open day is cancelled, and when somebody else assigns or removes them.
- **Notification center.** Settings has a central place for notification rules. A rule fires on an event, on a schedule or by hand ("Run now"), can go through each item of a list ("For each") with a summary instead of one message per item, and filters by conditions, including conditions on the recipient. Escalation sends a reminder to others when nobody reacts, a throttle caps repeats, and a dry run shows who would be reached and how often before anything is sent. The Activity tab lists every firing of the last 90 days with, per recipient, the channel, outcome and when the message was sent, delivered, seen and acknowledged.
- **Message categories with consent.** Messages belong to a category. Service and safety messages are always sent; everything else only if the person says yes. The question is asked once after sign-in and at the kiosk, and again when a category's text changes.
- **My notifications.** The profile menu has a page where each person allows categories, chooses channels per rule that reaches them, mutes rules that are not mandatory, and creates their own subscriptions (also from ready-made ones) that notify only them. Saved subscriptions can send a test to the person.
- **Pop-ups, banners and dialogs.** In-app messages can appear as a toast, a banner or a dialog, with a level (info, success, warning, error) and buttons that open a page or acknowledge the message. Delivery is tracked (delivered, seen, acknowledged), actions can be limited to people who are online with an e-mail as fallback, and escalation reacts to acknowledgement.
- **Notices on signage and tablets.** Rules can show a notice on signage displays and on the kiosk tablets.
- **New triggers** for visits, sales and accounts.
- **Check-out surveys at the tablet.** When a person checks out at the tablet and a survey is due, the tablet offers it: answer now, get it by e-mail, no thanks, or don't ask again. Surveys have a new delivery option "Ask at the tablet".
- **Kiosk pairing.** A kiosk is registered like a signage display: a browser opening `/kiosk` without a kiosk credential, or the desktop app after the Core URL is entered, shows a six-character code, and staff enter it under Settings › Devices & sessions › Pair device together with the usual device settings (`managed_devices.manage`). The browser then receives the managed-device cookie, the desktop app its one-time token; copying tokens or binding the browser by hand stays possible. Codes are stored only as digests and expire after 15 minutes; wrong codes, requests and polls are rate-limited, and optional `DEVICE_PAIRING_ALLOWED_CIDRS` limits who may request codes (migration 00128, [docs/managed-devices.md](docs/managed-devices.md#pairing-a-kiosk)).
- **Device settings.** Devices are set up with "Used as", tap check-out as an extra option, surveys at check-out and a kiosk reset time.
- **Anonymized staging data.** `admin anonymize-for-staging --confirm-irreversible-anonymization` turns a copy of the production database into data a staging installation may hold: stable fake names and `@example.invalid` addresses, no credentials, tokens, personal free text, personal files or audit log, mail pointed at Mailpit. It refuses to run unless `PUBLIC_BASE_URL` is a loopback origin. A schema-wide test fails when a new table or text column is not classified. See `docs/operations.md`.
- **Customer filament in printer slots.** A slot can hold filament the customer brought (optional type and colour), shown as "Customer filament" in the printer setup. Prints the connector records on such a slot book customer material: no stock movement, no material charge (#70).
- **Switch a run's usage to customer material.** A booked makerspace usage of any run, also one recorded automatically, can be switched to customer material; the stock booking is reversed and the job repriced (`machine_jobs.edit`, #69).
- **Web sign-in permission.** New permission `web.sign_in`: without it an account cannot sign in to the web app (password, PIN, passkey, OIDC) and its sessions stop working; sign-in and check-in at the tablet terminal and visitor enrollment stay possible. The Visitor role does not hold it, so visitors use only the terminal (#58).
- **Open-day view follows you.** The List/Calendar choice of the open-day pages is stored on the account and restored on every device (#55).
- **Open-day notifications.** New notification trigger "An open-day schedule is published or changed" and the ready-made subscription "Reminder for my upcoming open-day slot" (#47).
- **Recommended retention decisions.** Every data category except stored files comes with a recommended retention decision (trigger, period, action, purpose, legal basis and reason), seeded as a complete draft ready for approval. Nothing takes effect until a decision is approved and activated. See the table in `docs/privacy-and-retention.md`.
- **Print page.** Each recorded print has its own page at `/prints/{runId}` with title, printer, times, outcome, the timelapse, the 3MF previews and downloads, without material, prices or names. The job's recipient (a person) and staff with `machine_jobs.read` can open it after signing in; anyone else gets "not found" (`GET /print-pages/{runId}` and its content endpoints).
- **Timelapse notifications.** New trigger "A print's timelapse is ready" (`timelapse_ready`) when a connector's timelapse of a run with a job is stored, with the `{printPage}` placeholder (also on `run_finished`). E-mails link to the print page only for recipients who can sign in with a password; organizations and people without a password get the mail without the link.
- **Machine scope for notification rules.** Rules on triggers about a machine (printer errors, finished runs, filament changes, timelapses, new jobs) can be limited to some machines (`definition.trigger.machines`; empty means all; the catalog marks these triggers with `machineScope`).

### Removed

- **No ready-made notification rules.** The application no longer ships notification rules: migration 00127 deletes the rules seeded by migration 00115 (open-day changes, freed places, sign-up open, new Lab Rules, printer errors, finished runs and spool changes), so only rules staff create in the notification center send anything. Notifications already sent stay.
- **Android kiosk.** The Android app, its build check and the Android device bridge are gone; the desktop app is the only native shell. Managed devices report only the `desktop` platform, and migration 00112 drops stored Android hardware reports (the devices themselves stay).
- Settings › Lab operations › Open days & staffing, and the staffing level and open-days minimum fields of the role editor.
- **Order fulfilment mode.** Orders no longer ask whether the customer takes the items now or picks them up later; `fulfillmentMode` is gone from the order API (#56).

### Changed

- **Visits are anonymized at check-out.** A visit keeps its person only while the person is in the lab. Check-out (at the kiosk, by tapping a name, by a supervisor) adds the visit to the daily statistics, sets the person's last visit date and deletes the visit in the same transaction; voiding deletes an open visit. Ordinary check-ins and check-outs are no longer audited, corrections are audited without the visit or the person. `GET /visits` lists open visits only, and the statistics come from the daily totals, so `uniqueVisitors` is the sum of the daily unique visitors. Surveys use their own check-out reference, and expired tablet offers are deleted (migration 00129).
- **Privacy links where data is collected.** The kiosk, the public event signup, the public survey and the consent question and cards link the imprint and privacy policy; a legal page opened from one of them returns there.
- **Timelapses follow the camera rule.** On a display visible from outside, timelapses are shown only when cameras may be shown outside (`allowCameraOutside`); otherwise the widget stays empty and the clip endpoint answers 404.
- Excusal reasons and training notes say not to enter health details.
- **No tokens in the access log.** nginx logs the path without the query string, masks token segments of paths and no longer logs the Referer.
- **Clearer visitor enrollment at the kiosk.** Visitors are no longer asked for a phone number; the email address is required (`email` is required in `VisitorEnrollmentSubmission`, `phone` is gone). The sign-in method is chosen with the same switch as on the check-in screen, with the email invitation preselected and its address filled in from the first step. With a PIN the login name is suggested from the name, with a random number added when it is taken (`POST /visitor-enrollment/login-name-suggestions`). A new Messages step asks the notification consent right away (`consentCategories` in the enrollment state, `consents` in the submission, stored in the enrollment transaction), so a new visitor is no longer asked first at their next check-in. The wizard links the imprint and privacy policy, uses the full screen width, and the check-in screen shows "First time here? Register" as a highlighted box instead of a small button. The kiosk start screen is centred, and the consent switches at the kiosk show "No"/"Yes" next to them.
- **Material rows in one line, with calculations.** Wherever a run's material is chosen (new job, add to job, usage editor, mapping reported material) the material, the optional spool and the quantity share one line. The quantity takes basic arithmetic such as `20*30*2` or `(40-2)/4` (comma or dot as decimal separator), shows the result below while typing and becomes the result when leaving the field; a grey example in the empty field says so. The width × height × count inputs for cm² and m² are gone.
- **Open-day colours.** List and calendar show blue for days you hold a place on, red for days that still need people (managers: a free supervisor place; everyone else: a place you can take), green for full days and grey for cancelled ones. The separate "urgent within the warning window" state is gone from the schedule; the warning window still drives the dashboard hint and the freed-place notice.
- **"Fully staffed" counts supervisor places only.** A period's fully staffed and short-staffed day counts ignore open trainee places.
- **Period details delete with an icon.** The period panel has a delete icon button instead of the overflow menu.
- The semester tile and the dashboard's open-place hint follow the staffing rules (minimum, excusal, counting, warning window). The public JSON and ICS list one entry per open day with its timeslots in the description.
- The Filters button and the fixed detail panel of Open Days and Staffing are shared components.
- **Printer notification settings are now rules.** The migration turns today's settings into rules, so the behaviour stays the same; they can be edited in the Notification center.
- **Automatic survey e-mails need the Surveys & feedback consent.** People who have not allowed it are no longer mailed; they can still be asked at the tablet.
- **Release candidates.** Tags `vX.Y.Z-rc.N` build images and a GitHub pre-release for testing on a staging installation (notes from `[Unreleased]`).
- **Only full version image tags.** Releases no longer publish or move `latest` and minor/major image tags; pin the full version, such as `0.19.0`.
- The production backend waits up to a minute for the database before migrating, so the first start on a new volume no longer fails while PostgreSQL restarts after its initialization.
- `PUBLIC_BASE_URL` may use plain HTTP in production when its host is `localhost` or a loopback address, so an internal staging stack can be reached through an SSH tunnel. Every other production origin still needs HTTPS.
- **Finer inventory permissions.** `inventory.manage` is replaced by `inventory.articles.manage` (articles, material types, variants, new spools), `inventory.receive` (goods receipts and purchases), `inventory.consume` (consumption, transfers between spools) and `inventory.correct` (corrections, disposal, mark empty, retire and restore spools; a disposal needs it too) (#67).
- **Permissions grouped by app area.** The role editor groups every permission by the area it belongs to (People, Accounts & sign-in, Roles & audit, Open Days, Events, Trainings, Workshop, Inventory, Sales & cash, Signage, Notifications, Devices & kiosk, Lab Rules, Privacy, Settings & integrations); there is no "Other" group any more.
- **"Order outdated" only for billing changes.** A job on an order is flagged outdated only when something billed changes (runs and usages, machine, recipient, outcome, title, price adjustments, price), not for notes, the operator or the signage flag (#49).
- Notification rules before or after an open day may use up to 168 hours (was 72).
- **`admin cleanup` follows active retention policies.** A category with an active policy is cleaned with that policy; only categories without one keep their legacy period from `AUDIT_RETENTION`, `EVENT_SIGNUP_RETENTION` or the code. `--audit-before` is refused while audit events follow an active policy.

### Fixed

- **Imprint and privacy policy on the kiosk.** On the kiosk (`/kiosk`, visitor enrollment, the desktop app) both open in a dialog on top of the page instead of leaving it: an external document is framed, with a QR code for sites that refuse to be framed. The app's CSP now allows framing HTTPS pages (`frame-src 'self' https:`), and the desktop app admits the origins of the external documents it reads from Core's configuration.
- **Unbooked filament in Material usage.** The part of a print no spool fed (or whose quantity is unknown) now appears in the Material usage table of the run with a Map action, instead of only in the run details. The "Reported material" entry is gone from the run details.
- **Notification dialogs cover the screen.** A notification shown as a dialog pushed the page out of view and dimmed only the content area; it now lies over the whole app with the page visible beneath.
- **Open-day places lost role restrictions nobody chose.** Before the membership roles, a place listed the roles allowed to fill it; the migration kept those lists, so places showed custom roles such as a former supervisor role as "extra roles". Migration 00126 removes the lists of places that existed before that migration; restrictions set since then stay.
- **Upgrading a database with orders works again.** Migration 00123 of rc.2/rc.3 stopped on the first booked order item that came from a job ("order item content is immutable"). It now backfills the billing revision with the item guard switched off for that statement.
- **Mapping reported material uses the material picker.** The map dialog for a report line the printer could not assign chooses the material like the usage editor: a stock article with an optional spool, or the recipient's own material. Run and job pages list unmapped report lines in their Material usage table with a Map action, so a job's lines can be mapped without opening the run.
- **Visitor enrollment asks for the Lab Rules only when they are recorded.** While the Visitor role did not require the Lab Rules, the tablet still asked a new visitor to accept them, but no confirmation was stored. The Lab Rules step now appears only when the Visitor role requires them, and then the acceptance is listed under Lab Rules confirmations with the method "enrollment". `GET /visitor-enrollment/state` has the new field `labRulesRequired`.

### Upgrade notes

- **Back up the database before upgrading.** Migration 00129 deletes completed visits (after adding them to the daily statistics) and the check-in and check-out audit events. This cannot be undone.
- **Migration 00109 (membership roles and staffing rules).** Creates `staffing_rules`, `staffing_rule_exceptions` and `staffing_excusals`; marks or creates the Supervisor, Trainee and Visitor roles (a role already using such a name becomes "<name> (custom)"), gives each person the membership their former staffing-level roles implied, turns role minimum overrides of the remaining extra roles into exceptions, and adds the triggers that guarantee one membership per person. Drops `open_day_requirements`, `roles.staffing_level`, `roles.min_open_days_per_semester` and the visitor enrollment `initial_role_id`. Review the roles list after upgrading.
- **Migration 00110 (timeslots and series).** New `open_day_timeslots`, `open_day_series` (with timeslot and role tables); requirements and assignments reference a timeslot, and every existing day becomes one timeslot.
- **Migration 00111 (calendar feeds).** New `calendar_feeds` (digest only) and the new notification kinds; data category `calendar.feeds`.
- **Breaking API changes.** Roles lose `staffingLevel` and `minOpenDaysPerSemester`; visitor enrollment loses `initialRoleId`. `POST /people/{personId}/promote-to-supervisor` is replaced by `PUT /people/{personId}/membership` (removing a membership role directly answers 422 `membership_required`). `/open-day-requirements` is replaced by `/staffing-rules`. Open-day requirements and assignments belong to a timeslot (`timeslotId`), and `DELETE /open-days/{openDayId}/assignments/me` needs the `timeslotId` query parameter. The schedule save carries timeslots and series operations. `GET /supervisor-dashboard` rows are reshaped (membership, extra roles, minimum and its source, excusal, next assignment, competencies).
- **New endpoints.** `GET`/`PUT /staffing-rules`, `PUT`/`DELETE /open-day-periods/{periodId}/excusals/{personId}`, `GET /open-day-periods/{periodId}/series`, `PUT /people/{personId}/membership`, `GET`/`POST`/`DELETE /me/calendar-feed` and the public `GET /calendar/{token}.ics`. New audit actions include `person.membership_changed` and `calendar_feed.*`.
- **Configuration files.** The `openDayRequirements` section is replaced by `staffingRules` (older files' section is ignored; role `staffingLevel` and minimums are ignored on import).
- Documentation: `docs/open-days.md`, `docs/staffing-and-dashboard.md`, `docs/authorization.md`.
- **Migrations 00113-00120 (notification center).** Rules, categories, consents, firings and delivery tracking, subscriptions, device settings and the move of printer notification settings into rules. New permissions `notification_rules.read` and `notification_rules.manage`.
- **API.** `checkoutMode` on device settings is replaced by `allowTapCheckout`. `/printer-notification-settings` is removed (use the notification rules endpoints). `CurrentUser` gains `notificationConsentRequired`; the unread count carries `fresh` and `pinned`; notification rules, subscriptions, `/me/notifications/settings` and the rule activity are new.
- **Migrations 00121-00125.** 00121 splits `inventory.manage`: every grant becomes one grant of each of the four new permissions (scope, assurance and devices kept). 00122 grants `web.sign_in` to every role except master (always allowed) and the Visitor role. 00123 drops `orders.fulfillment_mode` and adds `machine_jobs.billing_revision` and `order_items.source_billing_revision` (orders outdated before the upgrade stay outdated until refreshed). 00124 adds `account_preferences`. 00125 lets printer slot mounts hold customer filament.
- **Breaking API changes.** `inventory.manage` is no longer a permission id. `fulfillmentMode` is removed from orders and is refused on `POST /orders` and `PATCH /orders/{orderId}`. Web sign-in answers 403 `web_sign_in_not_permitted` for accounts without `web.sign_in`. New endpoints `GET /me/preferences`, `PUT /me/preferences/{key}`, `POST /printer-slots/{slotId}/mount-customer-filament` and `POST /machine-runs/{runId}/usages/{usageId}/customer-material`; `PrinterSlot` gains `mountKind` and the customer filament fields.
- Visitors who used the web app lose access with this version; give a role `web.sign_in` in the role editor if some of them still need it.
- **Migrations 00126-00129.** 00126 clears role lists carried over to open-day places, 00127 deletes the seeded notification rules, 00128 adds kiosk pairing requests, 00129 anonymizes completed visits (see above).
- **Retention drafts.** A draft that was seeded from a legacy default and never edited is replaced by the recommended decision on the first read of the privacy registry; edited drafts, later versions and configured opt-outs (`AUDIT_RETENTION=0`, `EVENT_SIGNUP_RETENTION=0`) are kept. Review the drafts before approving them. Once a policy is active, a daily `admin cleanup` applies it, so check that the scheduled cleanup and the active policies agree before activating.

## [0.18.1] - 2026-11-06

### Added

- **Area tours are offered where they apply.** Opening Workshop, Sales & payments or Open days for the first time offers that area's tour, after the welcome offer is settled. "Not now" dismisses it for good; the help center still lists it.

### Fixed

- **The welcome tour offer no longer covers dialogs.** On a new account's first sign-in the "New here?" toast waits while a dialog or the profile or notification panel is open, so it never hides their buttons.

## [0.18.0] - 2026-11-05

### Added

- **Guided tours for new people.** Spotlight tours walk through Workshop (jobs, machines, inventory), Sales & payments and Open days (sign up, leave, assign a person) on the real pages; each page or tab change is its own step, and steps that save wait for a successful save. A new account is offered the tours on its first sign-in, and finished or dismissed tours are not offered again on other devices.
- **Demo mode.** Tours can run against an in-browser demo dataset, so new people can create jobs, sales and sign-ups without any record reaching the server.
- **Help center.** A Help page with Markdown articles and the tours of each area side by side, with the topics menu on the right.

### Upgrade notes

- **Migration 00108 (guided tour progress).** New table `account_guide_progress`; no data is rewritten. New endpoints `GET` and `DELETE /me/guides` and `PUT /me/guides/{guideId}` (any signed-in account, self-scoped, no audit), data category `guides.progress` (see `docs/guides.md`).

## [0.17.0] - 2026-11-05

### Added

- **Articles choose their own unit.** A material type's unit now sets its dimension: mass (g, kg), length (mm, cm, m), area (cm², m²), volume (ml, l) or count (pieces). Each article counts in any unit of that dimension, so strips in cm and boards in m can share one type and its rate. Rates of the type and its variants stay per the type's unit and are converted when an article in another unit is priced, quoted or counted in statistics. Piece articles can name their piece (Sheet, Pair, Roll); the name appears in stock, orders and invoices.
- **Units can be changed later.** An article's unit and a type's unit can change within their dimension at any time; stock, ledger entries, package size, low-stock threshold, article rates and run usages, or the type's rates, are converted in the same step. Captured job prices and order items keep their unit.

### Changed

- Orders, invoices, statistics and run usages show unit symbols (cm², m², pcs) instead of the raw codes.

### Upgrade notes

- **Migration 00107 (article units).** Adds the units kg, mm, cm and l, `materials.count_label`, and the SQL helpers `material_unit_dimension` and `material_unit_factor`; drops the foreign key that pinned an article's unit to its type's unit and lets the pricing-rule foreign key follow a type's unit change. Existing run usages get their unit stored. Down refuses while new units, count labels or article units that differ from their type's unit exist.
- **API.** `MaterialUnit` gains `kg`, `mm`, `cm`, `l`; new `MaterialDimension`; `MaterialType` and `Material` gain the required `dimension`; `Material`, `CreateMaterialRequest` and `UpdateMaterialRequest` gain `countLabel`. `unit` on article requests may now be any unit of the type's dimension (422 `material_unit_mismatch` otherwise). New audit action `material.unit_converted`. Configuration files carry an article's `unit` and `countLabel`; older files keep the stored ones.

## [0.16.3] - 2026-11-05

### Fixed

- **Prints started on the H2D's screen from a USB stick report their consumption.** For such a print the H2D reports the project title (`H2D / H2S / H2C USB Drive Protector`) instead of the file name (`H2D_H2S_H2C_USB_Drive_Protector`), so the connector took the archive for one on internal storage and reported the consumption as unavailable. Print and file names are now compared by their letters and digits only.

## [0.16.2] - 2026-11-05

### Fixed

- **An AMS backup refill on the H2D splits the consumption between both spools.** While the H2D prints the tail of a run-out AMS spool, it reports the hotend's source as external holder 255. The connector recorded that empty holder as a spool of its own, so the switch to the backup tray no longer counted as a refill and the whole quantity was booked on the backup spool. The connector now ignores an external holder without filament while the line's tray has run out. X1C refills were already split correctly.

## [0.16.1] - 2026-11-05

### Upgrade notes

- **Migration 00106 (Bambu tray UUID identifier).** `filament_spool_identifiers.kind` accepts the new value `bambu_tray_uuid`; no data is rewritten. Down deletes the `bambu_tray_uuid` identifiers. Update the printer connector together with Core so it reports `trayUuid`.
- **API.** The spool identifier kind enum (`FilamentSpoolIdentifier`, `NewFilamentSpoolIdentifier`, `AddFilamentSpoolIdentifierRequest`, the `kind` parameter of the spool lookup) gains `bambu_tray_uuid`. `PrinterLiveStatusTray` gains the optional `trayUuid`. `DetectedSpoolTag` gains `trayUuid` (nullable) and its `tagUid` becomes nullable: a tray may report only a tray UUID. A spool is resolved by `trayUuid` against `bambu_tray_uuid` first and, when there is none or no spool carries it, by `tagUid` against `nfc`; spools registered with a chip UID as `nfc` therefore keep matching. The detected tags list shows a spool seen in several trays once.

### Added

- **About page.** The About page describes the lab and the areas of the application and shows the release version (linked to its GitHub release; development builds say so), the Apache License 2.0 with its copyright holder, the source code, the third-party notices, the imprint and the privacy policy. The frontend image takes the version as the build argument `VERSION`.

### Fixed

- **A Bambu spool is recognised whichever of its two tags the AMS reads.** Each Bambu spool carries one RFID tag per flange with different chip UIDs but the same `tray_uuid`, and which one an AMS slot reads depends on the slot, so the same spool showed up under two serials and mounting by RFID missed it. The connector now reports the chip `tagUid` and the spool's `trayUuid`, Core identifies Bambu spools by the new identifier kind `bambu_tray_uuid`, and a slot that alternately reads both chips of one spool no longer starts a new consumption segment.

## [0.16.0] - 2026-11-04

### Upgrade notes

- **Migration 00104 (Lab Rules self-confirmation).** `laborordnung_requests` becomes `laborordnung_confirmations`: pending and superseded requests are deleted, completed ones stay with `method = 'paper'` and their document reference, signed date, archive note and checking supervisor (`required_version_id` → `version_id`, `completed_at` → `confirmed_at NOT NULL`; `status`, `previous_version_id`, `requested_at`, `superseded_at`, `created_at`, `updated_at` dropped; new `method` in `paper|app|kiosk|enrollment`, a check that only paper rows carry paper evidence, `UNIQUE (person_id, version_id)`). `laborordnung_versions` gains `announced_at` (the only column that may change on a published version); versions already in effect are marked announced, so deploying sends no notifications. `attendance_holds` is dropped, which also drops every held check-in. `laborordnung.requests.read` grants are renamed to `laborordnung.confirmations.read`; `laborordnung.confirm` grants are deleted. `lab_rules_confirmation_requested` notifications are deleted; the notification and mail outbox kinds gain `lab_rules_published`. Down restores the request table and holds without data (confirmations other than paper, `laborordnung.confirm` grants and holds are lost). Configuration files from earlier releases import `laborordnung.requests.read` as `laborordnung.confirmations.read` and skip `laborordnung.confirm`.
- **API.** Removed: `POST /laborordnung/requests/me`, `GET /laborordnung/requests`, `POST /laborordnung/requests/{id}/confirm`, `GET /laborordnung/signatures`, `GET /attendance/holds`, `DELETE /attendance/holds/{holdId}`, the `202` hold answers of the terminal and supervised check-ins, `PublicPresenceList.waiting`, `LaborordnungStatus.requestId`, `VisitorEnrollmentResult.labRulesRequestId`, `VisitorAdmissionResult.requestId`, the people filter value `pending`, the merge categories `attendance_holds`/`lab_rules_requests` (now `lab_rules_confirmations`) and conflicts `attendance_hold_conflict`/`lab_rules_request_conflict`, the permissions `laborordnung.requests.read` and `laborordnung.confirm`, and the notification kind `lab_rules_confirmation_requested`. New: `POST /laborordnung/confirmations/me` (any signed-in person, body `{versionId}`, returns `LaborordnungStatus`; 409 `lab_rules_not_required`, `lab_rules_unavailable`, `lab_rules_version_outdated`; audited as `laborordnung.confirmation.created`), `GET /laborordnung/confirmations` (`laborordnung.confirmations.read`; `search`, `versionId`, `personId`, `method`, `sort` `person|version|method|confirmedAt`, `direction`, `page`, `pageSize`; self-scoped with only `people.read.self`), `GET /terminal/lab-rules` and `GET /terminal/lab-rules.pdf` (device-authenticated, current version only), `LaborordnungStatus.latestConfirmedAt`, the optional `confirmLabRulesVersionId` and `deferLabRules` on the terminal check-in bodies (`TerminalPasswordCheckInRequest`, `TerminalPinCheckInRequest`) with 409 `lab_rules_confirmation_required`, `lab_rules_confirmation_suggested` and `lab_rules_version_outdated`, `VisitorEnrollmentSubmission.labRulesAccepted` (replaces `requestConfirmation`) with 409 `lab_rules_changed`, and the notification kind `lab_rules_published`. A supervised check-in of a `blocking` person who has not confirmed answers 409 `lab_rules_confirmation_required`. `VisitorEnrollmentResult.admission` is always `admitted` and `attendance` always `checked_in`. New audit events `laborordnung.confirmation.created` and `laborordnung.version.announced`; new scheduler job `laborordnung.announce`.
- **Migration 00105 (spool segments).** New table `machine_run_reported_usage_segments`; no data is rewritten. Update the printer connector together with Core so it reports segments.
- **API.** New `DELETE /pricing-rules/{pricingRuleId}` (`pricing.manage`, body `VersionRequest`, 204; 404, 409 `stale_write`), audited as `pricing_rule.deleted`. `DELETE /material-types/{materialTypeId}` now deletes the type together with its variants and all its pricing rules; it answers 409 `material_type_in_use` only while a material (deleted ones included) uses the type, no longer because of pricing rules. The audit event `material_type.deleted` carries `countPricingRulesRemoved` and `countVariantsRemoved`. No migration.

### Added

- **Filament booked per spool when a spool runs out mid-print.** When a print continues from another spool (the same slot refilled, an AMS backup slot, a spool of another colour), the connector splits the consumption line into segments by G-code layer, or by progress when no G-code split is possible, and Core books each segment on the spool that was in the slot when it started, with that spool's article and price. New table `machine_run_reported_usage_segments` (migration 00105); `MachineRunReportedUsageItem.segments`, `MachineRun.materialChangedDuringRun`, the consumption reasons `segment_without_spool` and `segment_quantity_unavailable`, and the spool attention `ran_out_during_run`. The run page lists a line's spools with grams and start, tags a segment without spool, offers staff to book it through the material correction, and says when the material changed during the print. A spool that ran out is flagged on its page and panel with Weigh and Retire at hand until it is weighed, retired or remounted. Update the printer connector together with Core to get segments.

### Changed

- **People confirm the Lab Rules themselves.** Nothing is signed on paper any more: a person reads the current version and ticks a checkbox, in the app, at the kiosk after their PIN or password (which checks them in at once) or while enrolling as a visitor. Roles in `warning` mode may confirm later and are admitted with a warning; `blocking` roles must confirm to be checked in, also when someone else checks them in. Held check-ins ("Awaiting sign-off") and the supervisor confirmation of signed paper are gone; earlier paper confirmations stay visible as history. When a version becomes effective, everyone who must confirm it is notified in the app and by e-mail, once. The frontend shows the rules in a modal in the app (not dismissible for `blocking` roles), on a standalone page `/lab-rules/confirm` and on the kiosk.
- **Prices and categories can be deleted.** A pricing rule can be deleted outright; stored job snapshots keep their rate. A material type with variants or pricing rules but no articles can be deleted, which removes its variants and rules; articles (deleted ones too) still block it. The configuration import's overwrite mode deletes such types instead of deactivating them.

### Fixed

- **Weighing a spool that holds more than recorded no longer fails** with "acquisitionUnitCost is required without an average cost". The found filament is valued at the spool's own purchase price, else the article's average cost, else 0 for existing stock whose price is unknown.

## [0.15.0] - 2026-11-03

### Upgrade notes

- **Product code from the tag.** `PrinterLiveStatusTray` gains the optional nullable fields `productCode` (Bambu `tray_id_name`, such as `A00-K0`) and `filamentProfileId` (`tray_info_idx`, such as `GFA00`); connectors before this release omit them. `DetectedSpoolTag` always carries both (null when the printer reports none). Update the printer connector together with Core to get them.
- **Migration 00103 (material type variants).** New table `material_type_variants` (`id`, `material_type_id` with `ON DELETE CASCADE`, `name` 1–80 trimmed characters, timestamps, `UNIQUE (id, material_type_id)`; names unique per type ignoring case). The backfill creates one variant per type and distinct free-text `materials.variant` (ignoring case, deleted articles included), named like the earliest article of that pair; the migration-created rows get PostgreSQL `uuidv7()` ids. `materials` gains `variant_id` (composite foreign key with the type, `ON DELETE RESTRICT`; `variant` and `variant_id` are set together) and `variant` now carries the variant's name. The variant text of part articles, which the application never offered, is cleared. `pricing_rules` gains `material_type_variant_id` (only on `material` rules, same composite key), and the unique index `pricing_rules_active_material_idx` is replaced by `pricing_rules_active_material_type_idx` (variant null) and `pricing_rules_active_material_variant_idx`: one active material rule per pricing group, type and variant. `machine_job_pricing_snapshot_rules` gains `material_id` and `material_type_variant_id` (copies without foreign keys) and the kind `stock_article`. Down refuses to run while a pricing rule has a variant or a snapshot rule has a variant or the kind `stock_article`, and otherwise drops the table, the columns, the index and the check changes (the variant text of parts is not restored).
- **API.** `MaterialType.variants` (`MaterialTypeVariant`: `id`, `materialTypeId`, `name`, `materialCount`, `pricingRuleCount`); `Material.variantId`; `PricingRule.materialTypeVariantId` and `materialTypeVariantName`, `materialTypeVariantId` on the create and update rule requests; `MaterialPriceSource` gains `material_type_variant`; `PriceQuoteMaterial.variant`. New `POST /material-types/{materialTypeId}/variants`, `PATCH|DELETE /material-types/{materialTypeId}/variants/{variantId}` (`inventory.manage`); errors `material_type_variant_exists` (409), `material_type_variant_in_use` (409), `material_type_variant_not_allowed` (422) and `material_type_variant_mismatch` (422). Audit `material_type.variant_created|renamed|deleted`.

### Added

- **Variants of a material type.** A filament or consumable type has a list of variants (Basic, Matte, Silk …), unique per type ignoring case; parts have none. An article's variant is one of them: an unknown name in an article or material request adds the variant to the type. Renaming a variant renames it on its articles and the generated article names that contain it (typed names and existing spool labels stay); deleting is refused while an article (deleted ones too) or an active pricing rule uses it; inactive rules (cleared rates) are deleted with the variant. The category dialog lists the variants and, for machine-use types, a rates table of variants × pricing groups; the Categories table has a Variants column and the article form picks the variant from the type's list.
- **Rates per variant.** A `material` pricing rule can price one variant of its type. An article's rate resolves as its own `stock_article` rule, else its variant's rule, else its type's rule, in machine runs, price quotes, sales from stock and `Material.prices` (`source` `stock_article`, `material_type_variant` or `material_type`). Sales → Pricing shows the variants as expandable rows under their type, with the inherited rate muted. Job pricing snapshots record the rule that priced a usage (`material_id`, `material_type_variant_id`, kind `stock_article`).

### Changed

- **Empty AMS trays unmount manual spools.** With RFID auto-mounting on, a tray the printer twice reports empty now closes whatever spool is mounted in that slot, including spools staff mounted by hand or registered from the detected-spool strip; the unmount has no account and appears in the connector's activity log as before. A tag the printer reads still never replaces a manual mount with another spool.
- **Honest colour suggestions for detected spools.** The detected-spools strip says **Match** only when the suggested article's colour is visually the same as the reported one, **Similar colour** when it merely resembles it, and **New article** otherwise, and always shows the reported colour next to the suggestion. A new article created from a detection is prefilled with the official Bambu Lab colour name when the printer reports a product code the catalogue knows (or an article with exactly the reported colour code has a name).
- **Machine runs use an article's own rate.** A run usage was priced by the material rate of its type only; it is now priced like a sale from stock, so a `stock_article` rule of the article (previously sales only) or a variant rate takes precedence over the type's rate. Stored snapshots are not rewritten.

### Fixed

- **Pages that re-render on a timer no longer jump to the top and swallow clicks.** The "Needs attention" banners of the printer setup and the article page used Carbon's `ActionableNotification` with its default `alertdialog` role, which focuses the banner's button after every render and traps focus there: once a tray reported a spool that was unmounted in Core (or an article was flagged), every 5-second refresh scrolled to the banner and the next click on Unmount or any other control was lost. Both banners are passive `status` notifications now, and a unit test keeps every inline notification that way.

## [0.14.0] - 2026-11-03

### Upgrade notes

- **Migration 00102 (editable cash entries) and permission `cash_movements.manage`.** `cash_movements` and `cash_counts` gain `version` and `updated_at`; their immutability triggers become identity guards (amount, time, reason, note and a count's figures may change; id, reference, operation key, kind, count link, creation time and recording Person may not), and a count's difference no longer requires a reason (a count recalculated after an earlier entry changed may have none). New permission `cash_movements.manage`; no role holds it by default, `master` has it. API: `PATCH|DELETE /cash-movements/{movementId}`, `PATCH|DELETE /payments/cash-counts/{countId}`; `version` and `updatedAt` on `CashMovement`, `CashCount` and `CashJournalEntry`; errors `cash_movement_is_correction` and `cash_balance_negative`. Audit metadata may carry `reference` and `previousKind|Amount|CountedAmount|OccurredAt|CountedAt|Reason`.
- **Migrations 00100–00101 (cash counts, register view).** New table `cash_counts` (immutable, `K-YYYY-NNNN`); `cash_movements` gains `cash_count_id` and the kind `correction` with the reason `count_difference` (signed amount); new view `cash_register_entries`. API: `POST|GET /payments/cash-counts`, `GET /payments/cash-journal`, `GET /payments/cashbook-export`; `CashRegister` gains `corrections`, `refundsAndCorrections` and `lastCount`; `CashMovement` gains `direction`, `cashCountId` and `cashCountReference`; `CashMovementKind`/`CashMovementReason` gain `correction`/`count_difference` while `CreateCashMovementRequest` keeps withdrawals and deposits only. The orders service uses `MAKERSPACE_TIME_ZONE` for whole days. Audit `cash_count.recorded`. People merge, data-subject exports and the privacy catalog cover the counts.
- **Migration 00099 (nozzles).** `printer_profiles.nozzle_count` (1 to 8, default 1) and `nozzle_index` (1-based, default 1) on `printer_input_units` and `printer_slots`. Units that named the right nozzle feed nozzle 2, their slots follow, and H2D profiles or profiles with a named nozzle get two nozzles. API: `nozzleCount` on `PrinterProfile` and `PrinterSetupRequest`, `nozzleIndex` on `PrinterInputUnit`, `PrinterSlot`, `PrinterSetupInputUnit` and `PrinterSetupSlot` (omitted keeps the stored value). The configuration export carries them; older files keep what is stored.
- **Migration 00098 (printer notification rules).** `printer_notification_rules` (one row per event: `printer_error`, `run_finished`, `filament_change`) replaces `printer_notification_settings.error_role_id` and `error_min_severity`, which become the printer_error rule (in-app only); `run_finished` and `filament_change` start with the operator only, as before. New table `notification_mail_outbox` holds queued e-mails (person or organization id, never an address) until the new scheduler job `inbox.mail_delivery` sends them. API: `PrinterNotificationSettings` is now `{events: [PrinterNotificationRule], version, updatedAt}` and `UpdatePrinterNotificationSettingsRequest` is `{events: [PrinterNotificationRuleInput], expectedVersion}`; `errorRoleId`, `errorRoleName` and `errorMinSeverity` are gone.
- **Migration 00097 (job signage flag, own material).** `machine_jobs.hidden_from_signage` and `machine_run_usages.material_type_id`; material the recipient brought no longer needs a free-text name. API: `hiddenFromSignage` on `MachineJob`, `CreateMachineJobRequest`, `UpdateMachineJobRequest`, `CreateMachineJobFromRunRequest`, `AttachMachineRunRequest` and the bulk create, combine and attach requests; `jobHiddenFromSignage` on `MachineRun`; `label` and `materialTypeId` on `MachineJobUsageInput` (`externalMaterialName` stays as an alias of `label`) and `label` on `MachineJobUsage`; `ManualRunInput.startsAt` is optional.
- **Attention flags.** `attention` (`{code, message}`) on `Machine`, `MachineJob`, `WorkItem` (lists) and `Order`.
- **Statistics.** `MachineLogbookStatistics` gains `usageByWeekdayHour`, `jobsByOutcome`, `jobsByWeek`, `materialByMonth`, `materialLossByType`, `materialChargesByType`, `pricingGroups` and `pricingGroupMonths`; `StatisticTotals` gains `notBilled`, `discounts`, `utilization` and `openDayUtilization`; `StatisticMachine` gains `utilization` and `openDayUtilization`.
- **Migration 00094 (spools without fills).** A spool is one filament unit: `filament_spools` gains `material_id`, `initial_net_weight_g` and `retired_outcome|retired_quantity|retired_by`, and loses `kind` and `label`; `filament_spool_fills` and the fill columns of `inventory_transactions`, `machine_run_usages` and `filament_spool_identifiers` are dropped (the fill history is gone). Each spool with an open fill keeps that fill's article and weights; spools without an open fill are archived and unmounted; spools that never held a fill are deleted. New labels `S-<TYPECODE>-<VARIANT>-<COLOUR>-<NN>`, unique among active spools only; existing spools keep `S-YYYY-NNNNNN`. The function `filament_spool_remaining(uuid)` derives a spool's remainder from the ledger.
- **Migration 00095 (codes and stock prices).** `material_types.code` (backfilled from the first word of the name, numbered when repeated) and `material_types.machine_use` (true for filament and for types any pricing rule references); `materials.display_id` (`A-0001`, by creation order); pricing rule kind `stock_article` with `pricing_rules.material_id`. Every former `materials.sale_price` becomes a `stock_article` rule in every pricing group, then the column is dropped.
- **Migration 00096 (inventory recycle bin).** `deleted_at`/`deleted_by` on `materials` and `inventory_transactions`; balances, spool remainders, ledger lists and statistics leave deleted entries out. Ledger rows may be hard-deleted only by a purge (session setting `makerspace.inventory_purge`); `inventory_transactions.material_id` cascades, `machine_run_usages.material_id` and `machine_run_reported_usage_items.material_id` are set null on purge and run usages keep `material_name`/`material_unit`.
- **Removed API.** `POST /filament-spools/{spoolId}/fills`, `POST /filament-spools/{spoolId}/finish`, `POST /filament-spools/cleanup`; the receipt placement `reusable_spool`; `salePrice` on articles, article requests and price quotes (`PriceQuote.saleAmount`, `PriceQuoteMaterial.salePrice`); `Material.deletable`; spool fields `kind`, `label`, `status`, `fillNumber`, `fillId`, `filledAt`, `productName`, `fills`; `fillNumber`/`fromFillNumber`/`toFillNumber` on ledger entries and `fillNumber` on run usages; the spool list filters `kind` and `status`; the schemas `FilamentSpoolKind`, `FilamentSpoolStatus`, `FilamentSpoolFill`, `LeftoverOutcome`, `FilamentLeftoverInput`, `FilamentNewFillInput`, `ChangeFilamentSpoolFillRequest`, `FinishFilamentSpoolRequest` and `CleanUpFilamentSpools*`. The order error `sale_price_required` is now `article_price_missing`.
- **New permissions** `inventory.delete` (articles into the bin, restore, purge of articles and retired spools) and `inventory.ledger.delete` (single ledger entries). No role holds them by default; `master` has them. `DELETE /materials/{materialId}` now needs `inventory.delete` and moves the article into the bin instead of hard-deleting it.
- **Migration 00093 (scene font).** Adds `signage_scenes.font_family` (`sans`, `serif`, `mono`, `custom`; default `sans`) and `font_asset_id`. New fields `fontFamily` and `fontAssetId` on `SignageScene` and `SignagePlayerScene`; the create request takes them optionally.
- **Migration 00092 (display groups).** New tables `signage_display_groups` and `signage_announcement_groups`; `signage_displays.group_id`; `signage_rules.display_id` becomes nullable and `signage_rules.group_id` is added (exactly one of them is set); `signage_default_scenes` can belong to a group. New endpoints `GET|POST /signage/groups`, `GET|PUT|DELETE /signage/groups/{groupId}`, `POST /signage/groups/{groupId}/publish`, `GET /signage/groups/{groupId}/preview` and the rule endpoints under `/signage/groups/{groupId}/rules…`; `groupId` on `SignageDisplay`, `PairSignageDisplayRequest` and `UpdateSignageDisplayRequest`; `groupIds` on announcements; the error `display_in_group` (409) for rule writes on a display in a group; the reference kind `group`. `SignageRuleList.displayVersion` is renamed `ownerVersion`. New audit actions `signage_display_group.created|updated|deleted|published|rules_reordered`. Rolling back copies each group's rules and default list to its members.
- **Migration 00091 (scene lists).** Rules and the display default now carry an ordered list of scenes: new tables `signage_rule_scenes` and `signage_default_scenes`; `signage_rules` loses `target_kind`, `target_scene_id` and `target_playlist_id`, `signage_displays` loses `default_playlist_id`, and `signage_playlists` and `signage_playlist_items` are dropped. Playlists are embedded in the rules and defaults that used them; a rule whose playlist was empty is deleted, and a display whose default playlist was empty gets a one-item list with a scene named `Blank` created by the migration. Removed API: `/signage/playlists*`, `SignagePlaylist*`, `SignagePlayerPlaylist`, `SignageRuleTargetKind`, `targetKind` and `targetId` on rules, `defaultPlaylistId`, and the pending-change kind `playlist`. New: `scenes` on rules and `defaultScenes` on displays and groups (`SignageSceneListItem`), `defaultScenes` and `manifestVersion: 3` in the manifest.
- **Migration 00090 (aspect ratio).** `signage_displays` and `signage_scenes` get `aspect_width` and `aspect_height` (the stored pixel size or orientation, reduced); `orientation`, `resolution_width` and `resolution_height` are gone. API: `SignageAspectRatio` replaces `orientation` and `resolution` (and the schemas `SignageOrientation` and `SignageResolution`) on displays, scenes, their requests and the player manifest.
- **Stored publications.** Publications made before this release are upgraded in memory when they are read (player manifest, preview, pending changes) and are not rewritten. Players drop a persisted manifest of the old shape and fetch the current one. Republish each display (or group) once so that the new manifest shape is stored; until then, pending changes may list "Default scenes" for displays whose default playlist was empty.

### Added

- **Edit and delete cash entries.** People with `cash_movements.manage` can edit and delete withdrawals, deposits and counts from the entry panel of the Cash register tab; counts after the change are recalculated with their corrections, and the register never ends up holding less than nothing.
- **Counting the cash register, journal and cashbook export (API).** A count records the counted cash against what the register should have held at that moment and books any difference as a correction with a reason, so the expected cash follows reality. The register journal lists every cash entry with its running balance, daily opening and closing balances, the expected cash at the end of the period with its derivation, the last count and the period's facts. The cashbook downloads as the HTU Kassabuch PDF, a faithful copy of the paper form (letterhead, a first sheet with the head block and 14 rows, further sheets with 17 rows, each carrying the balance over and closing with Summe/Bestand, and a final sheet with the totals, the opening and closing balance and the three signature fields), or as CSV for Excel, either for the cash register or for all payments.
- **Sales screens rebuilt.** The Orders list flags orders that need attention in its last column and, from 1056 px on, shows the selected order in a panel with its amounts, items and payments. The order page has fact tiles, a needs-attention notice, Items and Payments tables, Balance and Customer cards, and **Add item** for a finished job of the customer, an article from stock at the customer's group price, or a custom line; a missing group price is explained with a link to Pricing.
- **Articles sold from stock on the Pricing page.** The rates table groups its rows (machine time, measures, materials used on machines, articles sold from stock), can be searched, and opens a rate dialog per cell that creates, changes or removes an article's `stock_article` rule. Only articles of material types without machine use are listed; articles of machine-use types sell at the type rate.
- **Jobs off signage.** A whole job can be kept off signage when it is created, edited, claimed from a recorded run or receives a run; its runs then never show their machine, camera or timelapse.
- **Recipient's own material by type.** Material the recipient brought can name its material type and a short label ("PLA, recipient's own, Prusament Galaxy Black"); it is never charged. Manual runs always record measured material, and a manual run starts now unless a past start is given.
- **Needs attention.** Jobs, the jobs table, machines and orders say what needs someone: failed runs, unconfirmed material, no recipient, not on an order, missing outcome or price, outdated order; offline or failing connectors, open printer errors, maintenance, runs waiting for a job; overdue balances, changed jobs and open invoice requests.
- **Printer notification rules.** Printer errors, finished runs and filament changes each choose whom they tell (the run's operator, the job's recipient, a role) and whether by e-mail as well; people without a staff account get the e-mail only.
- **Nozzles.** Printers record how many nozzles they have and which nozzle each spool unit and slot feeds.
- **More statistics.** When the machines run (weekday and hour), jobs per week and by outcome, material per month and type, losses and charges per material type, charges by pricing group and per month, discounts, unbilled jobs and utilization overall and on open days.
- **Spools as filament units.** Spools are registered from loose stock or a purchase, get a readable label from their article, and are retired (`POST /filament-spools/{spoolId}/retire`, `outcome` `empty` or `discarded`) instead of being refilled or finished. Spools carry `attention` (`remainder_low` below 10 % of the initial net weight).
- **Article numbers, type codes and machine use.** `Material.displayId`, `materialTypeCode`, `machineUse`, `attention` (`low_stock`); `MaterialType.code` and `machineUse` (create and update accept both).
- **Sale prices per pricing group.** `stock_article` pricing rules (`materialId`, rate per unit of the article); `Material.prices` lists the sale price per active group (`source` `stock_article`, else `material_type` for machine-use types). Order items of an article default to the price in the customer's group; the price quote prices an article without a machine as a stock sale (`PriceQuoteGroup.materialPriceSource`).
- **Inventory recycle bin.** `GET /inventory/recycle-bin`; `DELETE /inventory/ledger/{transactionId}`; restore and purge under `/inventory/recycle-bin/materials/{materialId}`, `/spools/{spoolId}` and `/ledger-entries/{transactionId}` (`…/restore`, `…/purge`).
- **Aspect ratios.** Displays and scenes have an aspect ratio instead of an orientation and a pixel resolution: 16:9, 9:16, 21:9, 32:9, 4:3, 3:4 or a custom ratio, reduced by the server. A rule can only show scenes with the ratio of its display.
- **Scene lists in rules and as the default.** A rule and a display's default show an ordered list of scenes with seconds and a transition; a one-scene list shows that scene continuously. The Playlists section is gone.
- **Display groups.** Displays with the same aspect ratio can be put in a group that owns their rules and default scenes and is published at once (Signage › Displays › Groups). Joining a group replaces a display's own rules, leaving keeps a copy of the group's.
- **Announcements for groups.** An announcement can target groups next to displays.
- **Scene font.** A scene has its own font (sans, serif, mono or an uploaded WOFF2) that widgets set to "As the scene" follow.
- **Date-only clock.** The clock widget can show just the weekday and date.
- **Duplicate.** Scenes, announcement templates and custom layouts can be duplicated from the Content page.
- **Scene editor saves on request.** Save, Discard, Undo and Redo (Ctrl/Cmd+S, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) replace autosave, and leaving with unsaved changes asks first.
- **Timelapse widget.** Plays the timelapse videos of recent finished prints (all machines or selected ones, newest N, maximum age and length, optional caption); runs hidden from signage never appear. Core lists the clips in the live payload (`SignagePlayerLive.timelapses`), serves them to players (`GET /signage/player/timelapses/{runId}/{sha256}`) and to the admin preview (`GET /signage/timelapses/{runId}/content`), and players cache them.
- **Dark mode.** The staff application and the sign-in pages follow the system's light or dark setting (Carbon g100 in dark mode, including menus, modals, tables and charts); **Use dark theme** / **Use light theme** in the profile panel overrides it on this browser. Kiosk, visitor, public and signage pages keep their light styling.
- **New background.** A faint workshop photo replaces the blueprint images behind the application and the sign-in pages; in dark mode it is dimmer and inverted. The default branding assets are now `/brand/bg-makerspace.webp`.

### Changed

- **Payments page: Cash register and Cashbook tabs.** Cash register (the default) lists every cash entry from the register journal grouped by day, with opening and closing balances and the running balance, next to a panel with the expected cash and its derivation, Count, Withdraw and Deposit, the last count and the period's cash in and out; a row shows the entry in the panel (narrow screens open the payment page). **Count the register** shows the expected amount at the counting time and the difference, and books a difference with a reason. Cashbook keeps the takings tiles and every payment, now with a row menu (open payment or order, receipt, refund or correct). Both tabs share a period filter (All time, Today, This week, This month, Custom range…) shown as a removable tag, and **Export** downloads the server-rendered Kassabuch PDF or CSV for whole days; the browser-built CSV is gone. In dark mode tables and panels keep the dark layer colour again.
- **Section tabs on Jobs and Inventory.** Jobs has the tabs All · Needs attention · Recycle bin under its title (the former recycle-bin page redirects to the tab), and Inventory has Articles · Spools · Categories · Recycle bin under the title as on Machines: filament, consumables and parts are one Articles table (the former Materials and Parts tabs redirect to it). The work-items API takes `attention=true` to list only items with attention flags and accepts `planned` as a status.
- **Page headers.** The one-line description under page titles is gone from every page.
- **Detail panels.** Next to a list, the panel column is at least as tall as the list; its content stays in view while the list scrolls, and the fourth line of the panel head has room for tags.
- **Receive stock.** One dialog for every article: pick any article or describe a new one, whose kind follows the chosen type (or the Kind select for a new type). The question which kind to receive and the New article button of the Inventory page are gone; new articles arrive with their first receipt or spool.
- **Lighter sign-in page.** The sign-in forms keep their state in plain React, which takes the form library out of the initial bundle (about 14 kB gzip less to load before the first page).
- **Lighter layer colour.** Tables, cards and panels of the light theme sit on a slightly lighter grey.
- **Demo data.** `make seed-dev` stores a live status for the X1 Carbon whose AMS reads the tag of the mounted spool and one unregistered spool, so the Spools tab offers to register it.
- **Statistics page.** Statistics (now under Administration) has the tabs Overview, Machines, Materials, Money and Explore, a period choice of 30 days, 3, 6 or 12 months or a custom date range, and new charts for when the workshop is busy (weekday × hour), jobs per week and by outcome, material cost per month and type, losses and margin per material type, and charges by pricing group and process. Every chart can be shown as a table.
- **Jobs page.** Jobs only, with the runs machines reported without a job in a strip above the table (Claim, Delete), a filter row of comboboxes (status, outcome, machine, process, runs, billing, recipient, operator), the attention flag per row and a detail panel next to the table from 1056 px. The row selection with batch actions is gone from the page.
- **Job page.** Fact tiles, a Notes card with its own edit button, one **Add** button for recorded or manual runs, a **Print files & timelapses** slideshow with the job's On/Off signage toggle, and Price & billing with **Add to order** (the recipient's draft order or a new one) and **Adjust price** in the card.
- **Run page.** Report lines without a spool can be recorded as the recipient's own material; the media card replaces the preview tile; **Claim** attaches the run to a job on its machine or creates a job, optionally off signage.
- **Job dialogs.** New job starts with machine and recipient empty and the signed-in operator, asks whether the first run starts now or is already done (with its start), and has the signage opt-out. Material rows pick from a wider catalog picker with stock and sale prices or record the recipient's own material by label and category; manual runs have no basis field. Every choice list is a fuzzy combobox.
- **Inventory screens.** Articles and spools tables with a permanent detail panel from 1056 px on (row click opens the article or spool page below that), attention flags, article numbers and spool labels; rebuilt article and spool pages; a Recycle bin tab for deleted articles, retired spools and deleted ledger entries with Restore and Delete permanently; Delete article and Delete ledger entry (permissions `inventory.delete`, `inventory.ledger.delete`); Register spool from loose stock, a purchase or a tag a printer detects (with mount); Weigh and Retire on spools; code, kind and machine use in the type dialog. The article form has no sale price any more and points to Sales → Pricing. The change-filament wizard, Finish spool, Clean up archived spools and the reusable-spool placement of Receive stock are gone.
- **Machines.** The Machines page has the tabs Machines · Processes · Printers. The machines table shows availability, activity, jobs, failure rate, connector state and what needs attention; a row opens the machine in a panel next to the table on wide screens. Printers holds the error catalog (component and severity read from the code, filters for family, component and source, a row opens the meaning), the code list fetch and the printer notification rules per event.
- **Machine page.** Fact tiles, the machine's jobs, material categories, a live card and facts; Edit machine is a button in the page header.
- **Printer setup page.** The printer setup moved to `/workshop/machines/{machineId}/printer` (the former `?tab=printer` link redirects) with connection and recording cards, spool slots per unit with the nozzle each feeds, Register for a spool the printer reports (from loose stock or as a purchase, tagged and mounted), Mount and Unmount, and the printer's latest events.
- **Nozzles in the machine wizard.** The Spool inputs step sets the number of nozzles and the nozzle each input unit feeds.
- **Player chunks.** The camera manager, QR codes, the open-day, event and agenda lists, the calendar, the timelapse widget and the pairing screen are loaded on demand, so the player stays inside its bundle budget.
- **Workshop routes.** Jobs, Machines and Inventory moved from `/machine-logbook/…` to `/workshop/…` with the same sub-paths; every former URL redirects with its sub-path and query, and `/machine-logbook` and `/machine-logbook/overview` open Jobs. The Workshop navigation group no longer has an Overview page. API paths are unchanged.
- **Statistics under Administration.** Statistics left the Workshop group and is a top-level navigation entry under Administration, directly above Settings, at `/statistics` (breadcrumb Administration / Statistics); `/workshop/statistics` and `/machine-logbook/statistics` redirect there.
- **Sales overview removed.** The Sales & payments group holds Orders, Payments and Pricing; `/sales` redirects to Orders, its review of jobs ready to bill moved to the Orders list and the Price lookup to the Pricing page.
- **Needs attention on the Orders list.** A Needs attention tab lists overdue balances, orders changed since billed, invoices awaiting approval, partly paid orders and old drafts, with a filter by reason and a notice of finished jobs that are on no order.
- **Order actions in the Orders list.** The order page has no overflow menu any more: drafts get an Edit order button, and Edit customer and hand-over, Create replacement draft, Correct order and Cancel draft are in each row's menu and in the order panel.

### Fixed

- **Uploaded fonts vanished after a failed load.** A font whose first load failed (network blip, restart, token rotation) stayed missing in the preview and on the display for the rest of the session. Fonts are now registered through the Font Loading API and retried with backoff.

## [0.13.0] - 2026-11-01

### Upgrade notes

- **Migration 00089 (error code sync).** Adds `printer_error_codes.source` and `printer_error_code_sync`. New setting `PRINTER_ERROR_CODE_SOURCE_URL` (default Bambu Lab's published list; empty turns the fetch off); the API now makes an outbound HTTPS request to that host at start and daily. New endpoint `POST /printer-error-codes/sync`; `PrinterErrorCodeList` gains `sync`, `PrinterErrorCode` gains `source`; audit `printer_error_codes.synced`.
- **Migration 00088 (processes).** `machine_types` becomes `processes` with `integration` (`none` or `fdm_printer`) instead of the `process` enum; new table `process_measures` (seeded with `stitches` for former embroidery types); `material_type_processes` links material types to `process_id`; `machine_type_id` is `process_id` on `machines` and `pricing_rules`; `training_machine_types` is `training_processes`; the measure CHECKs accept any key of the form `^[a-z][a-z0-9_]{1,39}$`. API: `/machine-types` is `/processes`, `Machine.machineType` is `Machine.process`, `machineTypeId`, `machineTypeIds` and `machineTypeName` are `processId`, `processIds` and `processName`, material types carry `processIds` instead of `processes`, `RunMeasures` is a map of measure keys. The configuration export section `machineTypes` is `processes`. The enum `fdm_printing`, `embroidery`, `uv_printing`, `laser_cutting`, `vinyl_cutting`, `other` is gone; audit actions are `process.created` and `process.updated` (older `machine_type.*` rows stay readable). The error code `machine_not_fdm_printing` is unchanged.
- **Migration 00087 (recycle bin).** Adds `machine_runs.former_job_id` and indexes on the deleted rows; new endpoints under `/machine-logbook/recycle-bin`. The people merge now also re-points `printer_error_occurrences.cleared_by_account_id`.
- **Migration 00086 (print file limits).** Adds `artifact_max_bytes`, `artifact_retention_days`, `artifact_max_count` and `artifact_max_total_bytes` to `run_recording_settings`; `RunRecordingSettings` and its update gain the matching fields (`artifactMaxBytesLimit` read-only). The privacy category "Print files and previews" gets a legacy period from the setting (0 = keep, the default). New audit action `print_artifact.trimmed`.
- **Migration 00085 (printer errors, timelapse limits).** Adds `printer_notification_settings` (one row), `printer_error_codes`, `severity` and `cleared_by_account_id` on `printer_error_occurrences`, and `timelapse_max_bytes`, `timelapse_max_count`, `timelapse_max_total_bytes` on `run_recording_settings`. New endpoints `GET|DELETE /machines/{machineId}/printer-errors`, `GET /printer-error-codes`, `PUT|DELETE /printer-error-codes/{sourceFamily}/{code}`, `GET|PUT /printer-notification-settings`; `RunRecordingSettings` gains `timelapseMaxBytes` (now writable), `timelapseMaxBytesLimit`, `timelapseMaxCount` and `timelapseMaxTotalBytes`; `MachineRunEvent` and `PrinterLiveStatusError` gain error details. New audit actions `printer_errors.cleared`, `printer_error_code.saved`, `printer_error_code.deleted`, `printer_notification_settings.updated`, `machine_run.timelapse_trimmed`. Printer error notifications now go to the operator of the running print and an optional role instead of everyone with `printer_connectors.read`.
- **Connector.** A print's 3MF is now looked for on the USB stick or SD card whatever storage the print runs from, with retries while the print runs and for 15 minutes after it ends; `artifact_on_internal_storage` now means that external storage held no archive for the print. New consumption details: `artifact_name_mismatch` (under `artifact_not_found_on_printer`) and `artifact_invalid` (under `artifact_rejected`). The connector's SQLite state gains a column on first start; older state files stay valid. Deploy the connector together with this Core.
- **Connector.** Printer error codes are reported in the form the printer shows (`0300-0D00-0001-0001`, print errors as eight hex digits) instead of decimals; an error open at the moment of the upgrade is reported once more under the new form. An upload the proxy in front of Core refuses with 413 is given up with reason `artifact_rejected` / `artifact_too_large` instead of being retried for a day. Deploy the connector together with this Core.

### Added

- **Error meanings fetched automatically.** The error catalog fills itself from Bambu Lab's published list (about 2000 HMS codes and 500 print errors with their English texts) at API start and daily, with a "Fetch now" button in Settings › Machines › Error catalog; meanings written in the app are never overwritten, and each entry shows where it came from. The catalog is searched, filtered (family, source) and paged on the server like the other lists.
- **Printer errors you can read.** The printer setup shows each error with its level, the code as the printer shows it, the meaning your makerspace recorded for it and a link to the Bambu wiki page; notices (common, info) are folded away. The machine's error history can be cleared. Settings › Machines gains an **Error catalog** (code → meaning, description, link; also reachable from an error without a meaning) and **Printer notifications** (which role is told besides the operator of the running print, and from which level on).
- **Recycle bin for jobs and runs.** Deleted jobs and runs are listed under Workshop › Jobs › Recycle bin and can be restored (a job with the runs deleted with it and the recorded runs it left behind; a run into its job when that job is alive) or deleted for good (not while the inventory ledger refers to their material; such entries say so and stay). Every delete in the app now asks first and says whether the item goes to the bin or is gone for good. API: `GET /machine-logbook/recycle-bin`, `POST …/jobs|runs/{id}/restore`, `DELETE …/jobs|runs/{id}`; audit `machine_job.restored|purged`, `machine_run.restored|purged`.
- **Timelapse and print file limits.** Settings › Machines › Recording sets the largest accepted video, how many videos are kept in all and how much storage they may take, and the same for print files (3MF): largest accepted file, how long they are kept, how many and how much storage; the oldest go first and a file a running print uses stays.
- **Machine events with meaning.** The run page's event list names what happened (printing started with the file name, paused, resumed, printer error with code, level, meaning and link, filament change between slots, consumption, outcome) and shows a repeated state once.

### Fixed

- **Print files on the USB stick were missed.** A Bambu printer may run a print from its internal storage while the same 3MF sits on the USB stick or SD card, in `/cache`, in the root, or in both. The connector used to look there once at most and then declared the file unreachable (`artifact_on_internal_storage`) for good; a stale `url` from the previous print, a missing `url`, a name the printer shortened or spelled differently, or an archive that appeared a little later all ended the same way, and the same name in both places was given up as ambiguous. It now keeps looking with backoff while the print runs and for a while afterwards, weighs the printer's path, the reported archive name and the print name in that order, compares names without fuzzy matching, resolves copies in both places by content (identical copies are one file; differing ones need the printer's layer count), validates the download and its project name before attaching it, and never stages or books the same archive twice. Runs whose archive cannot be identified end in an explicit reason (`artifact_not_available`, `artifact_ambiguous`, `artifact_name_mismatch`, `artifact_invalid`).
- **H2D print files never arrived.** The connector uploads 3MF files through Core's public address; the proxy in front of Core answered 413 for the larger H2D archives and the connector retried every two minutes for a day without telling anyone. It now gives up once, the run page says why (proxy body limit), and the print's material estimate still comes from the printer's report. The proxy's body size limit has to be raised, or the connector pointed at Core directly, for those files to arrive.
- **Printer error codes were decimals.** Codes such as `196610` are now `0501-0400-0003-0002`, so they can be looked up.

### Changed

- **Machine types are processes.** There is one price per process, and processes are edited by the makerspace: you name them, say whether they have a 3D printer setup and define the counted measures (such as stitches) their runs record. The fixed list of processes is gone; existing machine types keep their machines, prices and trainings.
- **Recording settings moved.** The Recording tab (timelapse collection, size and storage limits for videos and print files) sits under Settings › Printer connectors; how long videos and print files are kept is decided under Settings › Data › Privacy & data retention on the category pages "Run timelapses" and "Print files and previews", where the period that applies while no decision is active can be set.
- **Preview tile of an internal-storage print.** The tile now says only that Core has no print file, like any run without a 3MF; the warning on the page keeps the explanation.

## [0.12.1] - 2026-10-30

### Added

- **Frontend client allow-list.** The optional `FRONTEND_ALLOWED_CLIENTS` (comma-separated IPv4/IPv6 addresses, CIDR ranges and hostnames) makes the bundled nginx answer only those clients and loopback; everyone else gets `403` for every page, asset, API request and websocket. Hostnames are resolved once at container start; an invalid or unresolvable entry stops the frontend container. Unset keeps today's behaviour. A TLS proxy on another host must be listed itself ([Hosting](docs/hosting.md#restricting-frontend-clients)).

## [0.12.0] - 2026-10-30

### Upgrade notes

- **Breaking: the streaming gateway is gone, the printer connector bundle carries the cameras.** Printer cameras are now relayed by Core: the connector bundle runs the connector next to **go2rtc**, the connector relays each camera over its own outbound websocket to Core, and signage players watch through Core over a same-origin websocket. No gateway, public host, TLS certificate, Let's Encrypt/Cloudflare setup, port 8443/8555 or inbound firewall rule is needed any more. To upgrade:
  1. On the host that ran the old stack, stop and remove it: `docker compose down` in the `streaming-gateway/` or `local-services/` bundle directory (do not add `--volumes` unless you want them gone; the volumes hold nothing that is still needed and can be kept as a backup until you are sure). Remove the old directory.
  2. Download the new `makerspace-printer-connector-VERSION-compose.tar.gz` bundle, set `MAKERSPACE_VERSION` and `CORE_URL` in `.env` and run `docker compose up -d`. A host that already ran the standalone connector stack (`makerspace-connector`) keeps its identity. A host that ran `local-services` has its connector identity in the old project's volume: in Core issue a **New enrollment secret** for that connector (Settings > Local services > Printer connectors), put it into `CONNECTOR_ENROLLMENT_SECRET` and start; the connector keeps its assignments ([Hosting](docs/hosting.md#coming-from-the-previous-layout)). The bundle now has the services `connector`, `go2rtc` and `go2rtc-config-init`, publishes no port and runs go2rtc pinned by digest.
  3. Make sure the reverse proxy in front of Core passes websockets for `/api/v1/signage/player/cameras/*/stream` and `/api/v1/printer-connector/self/stream-*`, with idle timeouts of several minutes. The bundled nginx and Caddy do; nginx in front of it needs `Upgrade`/`Connection` headers (example in [Hosting](docs/hosting.md#reverse-proxy-and-websockets)).
  4. Roles that held `local_services.manage` need `printer_connectors.manage` to switch a camera on or off. The permission `local_services.manage` is removed and every stored grant of it is deleted by the migration.
     Cameras of enabled gateway assignments are carried over automatically: the migration switches **Stream camera** on for the machine's active Bambu connector assignment. Gateway rows, camera states, ticket keys and the revoked-display list are dropped.
- **Container uid.** The printer-connector image now fixes its user to uid 100 and gid 101 (what it always used) so go2rtc can read the configuration file the connector writes.
- **Plain `http://` Core URLs.** `CONNECTOR_ALLOW_HTTP` remains the only way to allow them (a VPN or Core on the same host); the video and the connector credential are then unencrypted on that link.

### Changed

- **Camera streaming is a switch on the Bambu connector assignment.** "Stream camera" (`cameraStreaming`) is set with the assignment (`printer_connectors.manage`); the connector renders the printer's RTSPS source itself and reports `live`, `idle` or `unavailable` and the viewer count in its heartbeat.
- **Players use MSE only.** Latency is about 1 to 2 seconds; the player jumps to the live edge when it lags more than 3 seconds. WebRTC and stream tickets are gone; the player's live data lists `streams: [{machineId, path}]`. Viewers need the same right as before: a paired display whose published scene contains the camera, and `allowCameraOutside` for displays visible from outside. Core re-checks the right every 15 seconds.
- **Bundles.** A release now attaches two Compose bundles (Core and the printer connector). The `makerspace-streaming` and `makerspace-local-services` bundles, the `-streaming-gateway` image, `make dev-streaming*`, `make test-streaming-compose` and `make test-local-services-compose` are removed; `make dev-connector` starts the connector and go2rtc.

### Removed

- The streaming gateway (binary, image, bundle, Settings pages, `/streaming-gateways*`, `/streaming-gateway/*`, `/local-services/*` camera and ticket-key endpoints), Ed25519 stream tickets, go2rtc WebRTC, ACME/Cloudflare certificates, ports 8443 and 8555, the permission `local_services.manage`.

## [0.11.1] - 2026-10-29

### Added

- **Authenticator enrolment by QR code.** Setting up an authenticator app (forced setup and Profile › Two-factor authentication) shows a QR code of the `otpauth://` URI next to the copyable key and the open-in-app link; the code is drawn client-side as an SVG by the `qrcode` package in a lazily loaded chunk, so the initial bundle is unchanged. See [Authentication](docs/authentication.md#second-factors-in-the-web-interface).
- **Table searches that find what the table shows.** Every list search now matches, case-insensitively and on partial words, the names and references a user sees: the Jobs and Runs table finds jobs and prints by recipient, operator, machine, job name, notes, display IDs and file names (`GET /machine-logbook/work-items`, `GET /machine-runs`, `GET /machine-jobs`); people are found by their full name in either order (matriculation numbers still only with `people.read.matriculation`); machines, organizations, articles, spools, orders, invoice requests, events and surveys match their secondary fields (external ID, contact and locality, colour and storage location, tag IDs and mounted machine, captured customer name, organizer, version title). Client-side tables (machines, material types, inventory, orders, cashbook, ready to bill, managed devices, currently here, privacy categories, holds and requests, media, staffing) match the labels their columns render. The `search` parameters in the OpenAPI contract and the feature docs list the fields per table.

## [0.11.0] - 2026-10-29

### Upgrade notes

- **Migration 00083 (greetings, notification kinds, links).** `branding_configuration` gains `fun_greetings text[]` (four English defaults) and `fun_greeting_share` (default 10); `inbox_notifications.kind` accepts `printer_error` and `filament_change`; `inbox_notifications.link` accepts `https://` URLs next to application paths. `BrandingIdentity` gains the required `funGreetings` and `funGreetingShare` (the configuration export's `branding` section carries them as optional fields). New endpoints `PUT|DELETE /notifications/messages/{messageId}`; new audit actions `inbox_message.updated` and `inbox_message.retracted`. Core now accepts the connector's `printer_error` events, which it rejected before, so printer errors are stored (and announced) for the first time; the Bambu connector looks a print classified as internal storage up by name during the print. Down deletes the new notification kinds and external links.
- **Migration 00082 (data-subject requests).** Adds `privacy_subject_requests`, `privacy_subject_request_steps` and `privacy_processing_activities`; seeds `privacy.requests.manage` and `privacy.requests.execute` into the master fresh-sign-in policy; new permissions `privacy.requests.manage` and `privacy.requests.execute` (not granted to existing roles); new endpoints `GET|POST /privacy/requests`, `GET /privacy/requests/{requestId}`, `POST /privacy/requests/{requestId}/transition`, `POST /privacy/requests/{requestId}/execute`, `GET /privacy/requests/{requestId}/export`, `GET|POST /privacy/processing-activities` and `PUT|DELETE /privacy/processing-activities/{activityId}`; the people-merge category `privacy_holds` now also counts moved data-subject requests.
- **Migration 00081 (retention policies).** Adds `privacy_policy_versions`, `privacy_retention_holds`, `privacy_retention_runs` and `privacy_retention_run_items`; seeds `privacy.policies.manage` and `privacy.retention.execute` into the master fresh-sign-in policy; new permissions `privacy.policies.manage` and `privacy.retention.execute` (not granted to existing roles); new endpoints `GET|POST /privacy/policies`, `PUT /privacy/policies/{policyId}`, `POST /privacy/policies/{policyId}/transition`, `GET|POST /privacy/holds`, `POST /privacy/holds/{holdId}/release`, `GET|POST /privacy/retention/runs` and `GET /privacy/retention/runs/{runId}`. `admin cleanup` now runs through the retention engine and records a run; it gains `--dry-run` and `--category <id>` (repeatable), and its output lists counts per category instead of the former four-counter line. In-app notifications and signage announcements are no longer pruned on reads; the scheduled job does it. Behaviour is otherwise unchanged while automatic runs are off. Down refuses while an active policy exists.
- **Migration 00080 (privacy registry).** Adds `privacy_settings` and `privacy_category_snapshots`, seeds `privacy.settings.manage` into the master fresh-sign-in policy; new permissions `privacy.read` and `privacy.settings.manage` (not granted to existing roles); new endpoints `GET /privacy/overview`, `GET /privacy/categories`, `GET /privacy/settings` and `PUT /privacy/settings`. Retention behaviour is unchanged.

### Added

- **Playful dashboard greetings.** The dashboard greets by the time of day and, in a configurable share of visits, with one of the playful greetings kept in Settings › Communication & appearance › Branding & legal ("Bogos binted?" and three more by default; `{name}` stands for the first name). The list and the share are part of the branding export. See [Personal dashboard](docs/staffing-and-dashboard.md#personal-dashboard).
- **Printer errors as notifications.** The first report of a printer error reaches everyone with `printer_connectors.read` and the operator of the print that is running on the machine, with a link to the machine's printer setup. Repeats and clearings stay quiet.
- **Filament changes as notifications.** When a Bambu connector sees a spool loaded or removed, a tag no spool in Core carries, or material without a readable tag, the operator of the running print is told (not every staff member); whoever has the printer setup open sees the same change as a toast. See [In-app notifications](docs/notifications.md#system-notifications).
- **Sent messages can be edited and retracted.** Settings › Messages lets the sender change title, text and link of a sent message for every recipient, including those who already read it, or retract it from everyone.
- **Notifications link to other sites.** A message link may be an `https://` address (a pasted `www.…` host is completed); such links open in a new tab. Application paths keep working as before.
- **New notifications pop up.** While the tab is open, new notifications appear as a toast at the top of the page; clicking it opens the notification's target.
- **Run and job pages.** On a run page the "Part of J-…" card sits top-left under the header; the timelapse lives inside the Preview tile as a second gallery item. On the job page the metrics read Start | Runtime | Material | Recipient, the details are tiles and the outcome is among them; "Customer" is called "Recipient" throughout jobs (orders and payments keep "Customer"). Cells of the Runs table that carry a hint show the value and a warning icon with a tooltip.
- **Privacy registry.** Every built-in feature area declares its personal-data categories in code, with owner, fields, retention triggers, actions, subject and legacy default. The registry persists snapshots, keeps orphaned categories visible, and adds privacy settings (controller, data protection contact, automatic runs off by default) in Settings › Data › Privacy & data retention. This release changes no retention behaviour; `admin cleanup` remains the production path. See [Privacy registry, retention and data-subject requests](docs/privacy-and-retention.md).
- **Data-subject requests.** Access and erasure requests are recorded in Settings › Data › Privacy & data retention (tab Data requests) and walk through a manual, audited identity check, an assessment (counts and outcomes per category, blockers, open holds), a four-eyes approval and the execution. An access request produces one ZIP archive (JSON per data category plus the profile image) stored as a private file; an erasure deletes the person through the existing deletion rules while financial records and audit events are retained without the person link. The record of processing activities lives in the new tab Processing activities. See [Data-subject requests](docs/privacy-and-retention.md#data-subject-requests).
- **Data requests redesigned.** The list says where each request stands (a five-step bar), what the next step is and who may take it, and when it is due; tiles filter by "your move", "waiting for someone else", due soon and closed. Each request has its own page: the five steps across the top with names and notes, the current step as one card with one action and an inline note, the assessment in plain words (what is deleted, kept without the name, kept for a legal obligation, and what blocks it), the facts and the timeline. Recording a request asks the questions in plain words. API: requests and their steps carry the resolved names of the person and the actors.
- **Export download and re-authentication.** Downloading an access export goes through the API client, so an expired fresh sign-in opens the "confirm it's you" dialog instead of showing the API's JSON answer in the tab. After a successful re-authentication the current user is fetched again, so the permissions that were withheld come back at once; the "Data requests" entry stays reachable while its permission only waits for a fresh sign-in.
- **Readable access exports.** The JSON documents in a data-subject export archive are indented like its manifest.
- **Retention decisions are edited on the category.** "Edit retention" in a category row opens the category's own page: the rule in three questions (when the clock starts, how long, what then), the why, what the rule means in plain words, the decision in force, the draft → approve → activate steps with their buttons, the version history, the last run and a dry run of the decision in force for that category alone. The retention policies table is gone; the API is unchanged.
- **Categories page as the entry of the privacy area.** The tabs are gone: Settings › Data › Privacy & data retention opens the categories directly; retention policies, holds, execution history, data requests, processing activities and settings are sub-pages with a breadcrumb back, reached from the context line under the summary tiles and from the rows. Someone who only handles data requests lands on them.
- **Categories tab with coverage at a glance.** Each data category now says in plain words what it contains, who it belongs to and what an erasure does to it, and shows whether a retention decision is in force, a hold pauses it, what the last run did and which processing activities name it. Summary tiles filter by coverage, a Carbon table toolbar carries search and a filter panel, and the opened row shows where the data is stored, the decision of record and the next action. Execution history, Holds and Settings follow the same layout, with the run result per category in plain words and a "Place hold" dialog that shows what is currently due. API: `PrivacyCategory` gains `contains`, `erasure` and `coverage`; `PrivacyOverview` gains the coverage counts, open holds and the last run.
- **Privacy settings, retention decisions and processing activities in the configuration export.** The new section `privacy` of Settings › Data › Export & import carries the controller, one retention decision per data category and the record of processing activities. Imported decisions arrive as drafts (or as a new draft next to an active policy) and are approved and activated on the importing instance; holds, runs, requests and the automatic-runs switch stay. See [Configuration export and import](docs/configuration-transfer.md).
- **Retention policy engine.** Each personal-data category has versioned retention policies (trigger, period, action, purpose, legal basis, reason) that move from draft through approval to activation, with a four-eyes rule and one active version per category. The first read seeds a draft from each legacy default, and a configured opt-out is seeded for review. Holds on a category or a person, and runs in dry-run or execute mode with counts-only history, are managed in Settings › Data › Privacy & data retention (tabs Retention policies, Holds and Execution history). `admin cleanup` is the legacy mode of the same engine. See [Privacy registry, retention and data-subject requests](docs/privacy-and-retention.md#retention-policies).

### Fixed

- **Settings behind a fresh sign-in no longer vanish.** Once a master's fresh-sign-in window had passed, pages and controls that need such a permission (Roles & Permissions, Branding & legal, Mail, Single sign-on, role assignment, password and MFA resets, the privacy area and whatever the sign-in policy lists) disappeared or turned read-only. The UI now treats a permission that only waits for a fresh sign-in as held: the entries stay, and the first request that needs it opens the "Confirm it's you" dialog and is repeated afterwards.
- **Pay now on the dashboard** looked different from "Record payment" on an order until an order page had been opened once; the payment form now carries its own styles.
- **Notification links to other sites** were treated as application paths and answered 404; they are stored as `https://` URLs and open in a new tab.
- **Printer error events** sent by the connector were rejected by Core as an unknown event kind; they are accepted and stored.
- **USB prints classified as internal storage** (the printer's `url` did not name the print) got their 3MF only after the print; the connector now looks the archive up by name on external storage while the print runs.

### Changed

- **Background jobs run through one scheduler with advisory locks.** The API process runs its periodic jobs (connector maintenance every five minutes, survey delivery and privacy retention) through one scheduler instead of separate loops. Each run takes a PostgreSQL advisory lock, so several API replicas never run the same job at once. While automatic retention runs are off, the retention job runs only the routines that already ran before, with their legacy periods. See [Privacy registry, retention and data-subject requests](docs/privacy-and-retention.md#scheduler-and-legacy-behaviour).

## [0.10.0] - 2026-10-27

### Upgrade notes

- **Migration 00078 (run recordings).** Adds `run_recording_settings` (one row: timelapses enabled, 90 days retention), `machine_run_connector_reports`, `machine_run_commands`, `machine_run_timelapses`, `file_blob_deletions` and `printer_connectors.commands_polled_at`. Run `goose up` before starting the new API; Down refuses while timelapses or queued blob deletions exist.
- **New setting `PRINTER_TIMELAPSE_MAX_BYTES`** (default 2147483648 = 2 GiB, 1 MiB to 8 GiB) bounds timelapse uploads; the timelapse upload route accepts bodies up to 8 GiB. Plan private file storage for the videos (retention via Settings, `timelapseRetentionDays`; 0 keeps them). The API process now also runs a five-minute maintenance pass (commands, retention, blob deletion).
- **Connector version.** Run reports, commands and timelapses need this release of the printer connector **and** of Core: the connector uses them only when Core's configuration announces `recordings`, and Core refuses commands (409 `connector_commands_unavailable`) for connectors that do not poll them. Older connectors keep working; their runs show `consumption_not_reported` instead of a specific reason. The connector's SQLite gains `run_reports`, `run_commands`, `consumption_revisions` and `timelapse_retrievals`, and staged videos use `timelapses/` in its data volume (up to the video limit while one upload is pending). Core now also quarantines 3MF uploads it rejects with 422 instead of retrying them for 24 hours.
- API: `MachineRun` gains the optional `consumptionStatus`; `PrinterConnectorConfiguration` gains the optional `recordings`; audit metadata accepts `commandId`. New connector endpoints `PUT .../runs/{runId}/report`, `PUT .../runs/{runId}/timelapse`, `GET .../runs/{runId}/artifact/content`, `GET /printer-connector/self/commands`, `PUT /printer-connector/self/commands/{commandId}/status`.
- **Migration 00077 (people merge).** Adds `people_merge_reference_guard()` and recreates the immutability triggers of `orders`, `order_items`, `order_adjustments`, `payments`, `payment_allocations`, `external_invoice_request_events`, `external_invoice_request_details`, `inventory_transactions`, `cash_movements` and `laborordnung_versions` with a `WHEN` clause: only inside a merge transaction (`makerspace.people_merge` set locally) may person/account references be re-pointed; everything else stays immutable. Seeds `people.merge` (10 minutes) into `master_reauthentication_permissions`. Run `goose up` before starting the new API; Down restores the triggers and removes `people.merge` grants and the policy entry.
- **New permission `people.merge`** (not granted to existing roles; masters receive it through the registry and need a fresh `strong_mfa` sign-in for it by default). New endpoints `POST /people/merge/preview` and `POST /people/merge`; new error codes `people_merge_blocked`, `merge_email_requires_account` and the conflict codes listed in the docs. Merging revokes every session of every involved account.
- Audit metadata now also accepts aggregate counts (`count…` keys with decimal values), used by `person.merged`.
- **Migration 00076 (second factors, step-up reauthentication).** Adds `mfa_totp_credentials`, `mfa_recovery_codes`, `webauthn_credentials`, `pending_logins`, `webauthn_challenges`, `second_factor_throttles`, `master_reauthentication_permissions` (seeded with `accounts.mfa.reset`, `accounts.password.set`, `branding.manage`, `mail.manage`, `oidc.manage`, `people.roles.assign`, `roles.manage` at 10 minutes), `role_permission_grants.reauth_within_minutes`, and `sessions.authenticated_assurance`, `mfa_setup_required`, `webauthn_credential_id` (passkey sessions have no auth identity; `auth_method` gains `passkey`). Run `goose up` before starting the new API; Down refuses while a grant requires a fresh sign-in and deletes passkey sessions.
- **New backend dependency** `github.com/go-webauthn/webauthn` v0.18.2 (passkeys) with its transitive modules. TOTP is implemented in `internal/security` (RFC 6238 test vectors). TOTP secrets are encrypted with `APP_ENCRYPTION_KEYS`; recovery codes are HMAC digests with `CHALLENGE_HMAC_KEY`; the WebAuthn relying party ID and origin come from `PUBLIC_BASE_URL`.
- **Behavior change for masters: existing masters must set up a second factor at their next login.** The master role's universal permissions now require a `strong_mfa` session. A master who signs in with a password and has no second factor gets a session limited to second-factor setup (`403 mfa_setup_required` everywhere else); after enrolling an authenticator app or a passkey the session becomes `strong_mfa`. A master session below `strong_mfa` (PIN, OIDC without an MFA ACR) only has what the account's other roles grant. The same forced setup applies to every account with a role grant that requires `strong_mfa`. Masters additionally need a fresh multi-factor sign-in within 10 minutes for the seeded policy permissions (changeable with `PUT /roles/master-reauthentication-policy`). Have the bootstrap master sign in once and enrol before relying on automation that uses master sessions.
- **Login API change.** `POST /auth/login` answers `202` with `SecondFactorRequired` and an HttpOnly pending-login cookie (`makerspace_mfa_pending`, `__Host-` in production) for accounts with a second factor; the session is created by `POST /auth/login/second-factor` or the passkey second-factor endpoints. New endpoints: `/auth/passkey/options|login` (usernameless passkey login), `/auth/reauthenticate` (+ `/passkey/options`, `/passkey`), `/auth/second-factors` (TOTP enrollment/confirm/removal, recovery codes, passkey registration/rename/removal; staff session only, no permission), `POST /accounts/{id}/second-factors/reset` (`accounts.mfa.reset`), `GET|PUT /roles/master-reauthentication-policy`. `CurrentUser` gains the required `authentication` object; `Account` gains `secondFactors`; `PermissionGrant` gains `reauthWithinMinutes` (also in configuration export/import). New error codes: `mfa_setup_required`, `reauthentication_required` (with `requiredAssurance`, `withinMinutes`), `second_factor_required`, `second_factor_invalid`, `second_factor_pending_invalid`, `second_factor_rate_limited`, `passkey_invalid`, `passkey_clone_suspected`, `totp_already_enrolled`, `totp_enrollment_not_started`, `second_factor_not_enrolled`, `encryption_unavailable`, `passkeys_unavailable`.
- **New permission `accounts.mfa.reset`** (not granted to existing roles; masters receive it through the registry).
- **Migration 00075 (surveys).** Adds question display conditions (`survey_questions.condition_*`), share links (`survey_share_links`), the response source (`survey_responses.source`, `share_link_id`) and `survey_has_responses()`; the immutability triggers of published survey versions, questions and options now block changes only once the survey has a response. Run `goose up` before starting the new API; Down refuses while links, link responses or conditions exist.
- **Survey API changes.** New: `DELETE /surveys/{id}`, `POST /surveys/{id}/reopen`, `GET|POST /surveys/{id}/links`, `PUT|DELETE /surveys/{id}/links/{linkId}` (`surveys.manage`), `GET /surveys/{id}/results/overview`, `/results/questions`, `/results/export.csv` (`surveys.read`), and the public `GET|POST /public/survey-links/{token}`. Changed: `GET /surveys` takes `search`, `status`, `sort`, `order`, `limit`, `offset` and returns `total` (generated clients: `listSurveys(params, options)`); `Survey` gains `responseCount` and `linkCount`; question input/output gains `condition`; `PublicSurvey.expiresAt` is nullable; `PUT /surveys/{id}` now also edits published or closed surveys without responses (409 `survey_has_responses` otherwise); answers to a hidden question are rejected (422 `survey_answer_not_applicable`). See [docs/surveys.md](docs/surveys.md).
- API additions, no migration: `GET /api/v1/laborordnung/signatures` (confirmed Lab Rules signatures, paged, searchable and sortable; `laborordnung.requests.read`) and `GET /api/v1/managed-devices/{managedDeviceId}/hardware` (configured, reported and effective capabilities of a device; `managed_devices.read`).
- Migration 00074 allows the new device capability `file_upload` (configured and reported capabilities). API: `DeviceCapability` gains `file_upload`; `VisitorEnrollmentState` carries `capabilities` (the enrolling device's effective capabilities); in `VisitorEnrollmentSubmission` `profileImageBase64` and `profileImageFilename` are now nullable.
- **Existing kiosks lose nothing but should be reviewed:** a profile photo is required only when the device's capabilities include `camera` or `file_upload`. A kiosk with neither now enrolls visitors without a photo. Tick `camera` and/or `file upload` on kiosks that should keep requiring one (Settings, Devices).

### Added

- **Claim run.** An unassigned recorded run has a "Claim run" action that opens the new-job dialog, with "Link to existing job" in the overflow menu next to it (straight to the matching dialog when only one is allowed); "Edit material usage" moved into the run's overflow menu. New jobs (single, per run and combined) start with the signed-in person as operator, who can still be changed.
- **Upload the 3MF of a recorded run afterwards, and record material from the run page.** For prints started from a Bambu printer's internal storage (which the connector cannot read), staff with `machine_jobs.edit` can upload the 3MF with `POST /machine-runs/{runId}/artifact` (raw body, any run state, also while running; audited as `machine_run.artifact_uploaded`; migration 00079). Previews, download, the filament estimate and consumption then work as for a retrieved file. Only a manually uploaded file can be replaced; a file the connector retrieved never is (409 `run_artifact_connector_retrieved`), and the connector's own retrieval supersedes a manual one. When neither the file name nor the project name matches the run's print name the upload still succeeds with `nameMismatch`, which the run page shows as a warning. When the run has ended, Core queues a `consumption_recompute` command for its connector; while it runs, the connector asks Core for the stored 3MF when the run ends, before giving up on an internal-storage print. The run page offers "Upload print file (3MF)" and "Edit material usage" (staff material still wins over the machine's report, with a warning when both exist). See [docs/machine-logbook.md](docs/machine-logbook.md#upload-a-3mf-afterwards) and [docs/printer-connector.md](docs/printer-connector.md#storage-detection-of-a-bambu-print).
- Merge wizard for duplicate people in the web interface: a "Merge people" action for 2 to 10 selected people and "Merge with…" on the person page (with `people.merge`), a per-field comparison with the blocking conflicts explained, role, account and history summary, and a confirmed, versioned merge that handles stale data and ending sessions. See [docs/people-merge.md](docs/people-merge.md).
- **Merge duplicate people (backend).** `POST /people/merge/preview` shows every person's field values, roles, account and authentication methods, the history that would move and every blocking conflict; `POST /people/merge` applies the chosen values to the target, unites roles, moves authentication methods to the surviving account, re-points every record of the duplicates (visits, holds, Lab Rules requests, training records, Open Day and event assignments, orders, jobs, payments, invoice requests, cash movements, surveys, memberships, notifications, audit history) and permanently deletes the duplicates, in one transaction with one privacy-minimized `person.merged` audit event. The web interface follows. See [docs/people-merge.md](docs/people-merge.md).
- Web interface for second factors: passkey sign-in and a second-factor step on the login page, forced second-factor setup with recovery codes, a "Two-factor authentication" section in the profile, a global "Confirm it's you" step-up dialog that repeats the original request once, a per-rule "Require fresh sign-in" window and the master sign-in policy in the role editor, and second factors with a reset action on the person detail page. See [docs/authentication.md](docs/authentication.md).
- **Recorded runs explain missing consumption, can be re-fetched and recomputed, and keep the printer's timelapse (backend and printer connector).** Run lists, run details and job details carry `consumptionStatus` (`recorded`, `partial`, `missing`, `pending` with a stable reason such as `artifact_retrieval_failed`, `no_slicer_weights_in_artifact` or `connector_offline_during_run`). New `GET /machine-runs/{runId}/recording` and `GET /machine-jobs/{machineJobId}/recordings` list a run's 3MF, plate previews, timelapse, timelapse status and connector commands; `/machine-runs/{runId}/artifact/content`, `/previews/{previewId}/content` and `/timelapse/content` (HTTP Range) download them with `machine_jobs.read`. `POST /machine-runs/{runId}/artifact-refetch` and `/consumption-recompute` (`machine_jobs.edit`, idempotent, five per run and hour, audited) ask the connector to fetch the 3MF again or recalculate. The Bambu adapters retrieve the print's timelapse video over FTPS after the print ends and stream it to Core; `GET`/`PUT /machine-logbook/recording-settings` controls collection and retention (default 90 days). The UI follows. See [docs/machine-logbook.md](docs/machine-logbook.md#consumption-status-files-and-timelapses) and [docs/printer-connector.md](docs/printer-connector.md#run-reports-commands-and-timelapses).
- Print previews, downloads, consumption reasons and timelapses in the web interface: run and job detail get a compact facts bar and a preview tile (several images with chevrons, arrow keys and a strip, job previews labelled with their run), 3MF and timelapse downloads, inline timelapse playback, an explanation for missing, partial or pending consumption with "Fetch print file again" and "Recalculate consumption" for people with `machine_jobs.edit`, a warning icon with the reason in the runs table, and a Recording tab on Machines for the timelapse settings. See [docs/machine-logbook.md](docs/machine-logbook.md#interface).
- Survey administration UI: server-side survey list, detail page with Questions, Results, Share links and Automatic delivery tabs, an editor with conditional questions ("Show only if…"), results with charts, filters and CSV export, share-link management, and a mobile-first public fill-out page that also serves share links at `/survey/link/<token>`. See [docs/surveys.md](docs/surveys.md).
- **Surveys: conditional questions, share links, results.** A question can be shown only when an earlier answer matches (choice, rating or yes/no), published surveys without responses can be edited or deleted, closed surveys can be reopened, public surveys get any number of anonymous share links (label, expiry, response limit, deactivate), and results show an overview, per-question aggregates (filterable by date, source and link) and a CSV export that neutralizes spreadsheet formulas. Backend only; the management UI follows.
- **Lab Rules signatures.** A Signatures tab on the Lab Rules settings page lists every confirmed signature (person, revision, signed date, physical document reference, confirmed by and at) with search, a revision filter, sortable columns and server-side paging. A person's page shows their latest signatures. Both need `laborordnung.requests.read`.
- **Managed device page.** Each managed device has its own page with general data, application modes and kiosk settings, and its configured, reported and effective capabilities, plus the token actions.
- **Photo source by device capability.** New device capability `file upload`. In kiosk enrollment, "Start camera" appears only on devices with `camera`, the upload only on devices with `file upload`; a device with neither hides the photo picker and enrolls without a photo (enforced by the backend).
- **Movable round photo mask.** After taking or choosing a photo, drag it (touch, mouse or arrow keys) under a round mask and zoom 1x to 3x; the visible square is uploaded as a 512x512 JPEG. The same cropper is used when staff change a profile picture.

### Changed

- **Prints started from a Bambu printer's internal storage are recognised.** The connector now classifies a print's storage from the `url` reported in the current session (the merged status keeps the previous print's `url`) and no longer waits for a 3MF it cannot read: Core shows the new consumption reason `artifact_on_internal_storage` ("Print file on the printer's internal storage") already while the run is running, in the consumption notice, the Filament estimate section, the preview tile and the run list, instead of "Waiting for the printer's 3MF file…". After the run the connector still looks the file up once on external storage. See [docs/printer-connector.md](docs/printer-connector.md#storage-detection-of-a-bambu-print).
- The initial JavaScript bundle shrank by about 7 kB gzip: the application entry no longer imports the generated `PermissionId` object (string literals typed by the generated type) and the former request-page redirect loads lazily.
- **Set password and change email on the person page.** With `accounts.password.set` an administrator can set a person's password directly (Actions menu and the Local password row), independent of mail delivery; it signs the person out everywhere and invalidates pending reset links. An account without a login email gets one in the same dialog, which needs `accounts.login_email.update` too (without it the action is hidden). Only a master may set the password or login email of a master account (403 otherwise); setting a password on an account without a login email now answers 422 instead of 500.
- Settings, Devices & sessions: managed devices and session policies are tables like the other lists (search, status filter, sorting, paging); creating a device and editing a policy happen in modals; device types are their own tab.
- All tiles on the settings overview have the same size.
- The kiosk photo hint only says that a photo is required when the device actually requires one.
- The entrance terminal is now called the kiosk everywhere in the UI, docs and code. The frontend route is `/kiosk`; `/terminal` redirects there, so deployed devices keep working. API paths, database values and the Android package ID are unchanged. The `android-terminal/` and `desktop-terminal/` folders are now `android-kiosk/` and `desktop-kiosk/`.
- An empty material row on a job or run records no material: it is neither validated nor saved, so work can be priced for machine time only.
- Long page titles, print preview captions and download labels stay on one line and end with an ellipsis; the full text is in the tooltip.

### Fixed

- The Lab Rules PDF modal now fits the screen height on iPad (landscape and portrait): header and close button stay visible and the pages scroll inside the modal.
- On the kiosk's on-screen keyboard (enrollment, check-in/out sign-in, staff login) the focused field and the Next or submit button stay visible above the keyboard; while it is open the "About you" step switches to one column and hides the photo column and progress header.
- The kiosk no longer crashes with "component should have no interactive child nodes" when the Lab Rules PDF cannot be shown inline.
- The Lab Rules PDF now renders on iPad Safari (pdf.js legacy build).
- The "How can we reach you?" label in visitor enrollment no longer wraps into a narrow column on iPad Safari.
- A tab opened before a deploy no longer breaks on missing chunks: a failed dynamic import reloads the page once, and other route errors show a Carbon error page.
- Print previews show one image per plate (the largest plate render); small copies, unlit renders and pick maps are skipped.
- Masters whose session predates second factors, or who signed in through OIDC without a multi-factor assertion, are sent to second-factor setup instead of silently losing permissions; accounts with a second factor but a weaker session get a "Confirm with second factor" notice.
- Passkeys are unavailable instead of stopping the API when `PUBLIC_BASE_URL` uses an IP address (WebAuthn needs a domain), so a local stack on `http://127.0.0.1` starts again.

### Dependencies

- Frontend: @carbon/charts, @carbon/charts-react, @carbon/icons-react, @carbon/react, @carbon/styles, @tanstack/react-query, marked, react-hook-form, sass, typescript-eslint and vite updated.
- Backend: aws-sdk-go-v2 (config, credentials, s3), smithy-go, kin-openapi, oapi-codegen nethttp-middleware and runtime, and modernc.org/sqlite updated.
- Desktop kiosk: @carbon/react 1.119.0, @carbon/styles 1.118.0, @tauri-apps/cli 2.12.4, sass 1.106.1, vite 8.3.5.
- Container base images: alpine 3.24.3 (backend, printer connector, streaming gateway), node 26.12.1 and nginx-unprivileged 1.31.7 (frontend); docker/login-action 4.7.0.

## [0.9.1] - 2026-10-24

### Upgrade notes

- Migration 00072 adds `open_day_periods.sign_up_deadline`. API: open-day periods carry `signUpDeadline` (nullable) and accept it on create and update; `Semester` carries `signUpBy`.
- Migration 00073 adds the check-in method `enrollment` for visits and held check-ins. `VisitorEnrollmentResult` carries `attendance` (`checked_in` or `awaiting_sign_off`).
- New permission `training_records.update.self`; only master has it until you add it to a role. Master can therefore now change its own training status.
- New setting `SURVEY_DELIVERY_INTERVAL` (default `1m`, `0` disables): the API now sends due survey invitations by itself, so a cron job running `admin deliver-surveys` is no longer needed.
- New frontend dependency `pdfjs-dist` (loaded only when the Lab Rules are opened during enrollment).

### Added

- **Sign-up deadline per open-day period.** The Leitung can set an optional sign-up deadline on a period, also while it is in staffing or published. The dashboard's "Sign up for … open days more by …" hint shows that date instead of the period's end date; without a deadline nothing changes.
- **Survey trigger settings.** On the survey page you can set the delay after check-out and the cooldown in days for the post-visit trigger, not only switch it on or off.
- **Automatic survey delivery.** The API checks every minute for due survey invitations and sends them. A failed send is retried after 5, 10, 20 and 40 minutes.
- **Change your own training status** with the new permission `training_records.update.self`, on the profile and on your own person page.
- **Lab Rules confirmations on the attendance page.** Besides the people waiting at the entrance, the notice at the top of the attendance page now also lists every other open Lab Rules confirmation request, with a confirm button.

### Changed

- **Visitor enrollment on the terminal is a three-step wizard** (about you and photo, sign-in method, Lab Rules) that fits the tablet without scrolling. Required fields are marked, and email and phone are explained as "at least one". After 30 s without input it asks "Are you still there?" and returns to the terminal if nobody answers. The screen after submitting explains the paper Lab Rules step and returns to the terminal automatically. The Lab Rules PDF opens inside the wizard instead of a new tab (the Android terminal could not show it otherwise).
- **Completing visitor enrollment checks the visitor in.** With Lab Rules mode `blocking` they wait as "Awaiting sign-off" and are checked in automatically when a supervisor confirms their signed Lab Rules; otherwise they are checked in right away. Before, they had to check in again afterwards.
- **Held check-ins appear in the "Currently here" lists** of the attendance page and the terminal as "Awaiting sign-off" instead of in a separate list on the terminal.
- **The attendance page updates every 5 s** (the terminal's presence list every 10 s).
- **Branding on the terminal:** logo, display name and brand stripe in the terminal header and the enrollment wizard; the start screen welcomes with the makerspace's display name.
- **Terminal:** "New here? Register as a visitor" moved from the start screen into the check-in screen. The enrollment and the staff sign-in (when opened from the terminal) have a back button to the terminal. The PIN shows one bullet per digit with a counter instead of six fixed dots, and the email/password fields use the full width.

### Fixed

- **Dependencies:** orval updated to 8.44.0 and `undici` 7 pinned to 7.30.1, so `pnpm audit` is clean again.
- **Dashboard:** the "Supervisor needed" box puts its sign-up button under the text when the tile is narrow, instead of squeezing the text.

## [0.9.0] - 2026-10-23

### Upgrade notes

- Migration 00067 adds `machine_runs.hidden_from_signage`. API: runs carry `hiddenFromSignage`; new `PUT /machine-runs/{runId}/signage-visibility`.
- Migration 00068 adds `roles.min_open_days_per_semester`. API: roles carry `minOpenDaysPerSemester`; supervisor dashboard rows carry `minimum`. Configuration files exported before this version still import; an overwrite import of such a file resets every role to the general minimum.
- Migration 00069 adds in-app notifications (`inbox_notifications`, `inbox_notification_roles`, `inbox_recipients`) and the permission `notifications.send`; only master has it until you add it to a role. API: `/notifications` (own list, unread count, read, read all, dismiss) and `/notifications/messages` (send and sent list). Notifications are deleted after 90 days.
- Migration 00070 adds held check-ins. Roles with Lab Rules mode `blocking` are no longer rejected at check-in (409 `attendance_admission_required`): the terminal and supervised check-in answer `202` with an `AttendanceHold` until the Lab Rules are confirmed. `PublicPresenceList` has a `waiting` list. New endpoints `GET /attendance/holds` and `DELETE /attendance/holds/{holdId}`.
- Migration 00071 adds trainings, competencies and training records, and the permissions `trainings.manage`, `training_records.read.self`, `training_records.read.all` and `training_records.update`; only master has them until you add them to roles. API: `/trainings`, `/competency-categories`, `/people/{personId}/training-records`. `OpenDay` and `PublicOpenDay` carry `competencies`, signage open days carry `competencies` (labels), the open_days, agenda and calendar widgets accept `showCompetencies`, and configuration files gain the sections `competencies` and `trainings`. The public ICS feed's `DTSTAMP` is now the generation time.

### Added

- **Training records.** Settings → Lab operations → Trainings & competencies defines trainings (for example a printer model) and the public competencies they feed (for example "3D printing"). On a person's Trainings tab, people with `training_records.update` set each training to Not trained, Trained or Can train others, with an optional date and internal notes; nobody can change their own status. Everyone with `training_records.read.self` sees their own trainings on the profile.
- **Planned support on open days.** Open days show which competencies the assigned supervisors bring, derived from their training records: on the open-day page, on the dashboard, in the public JSON and ICS feed, and optionally on signage (open-day list, agenda and calendar weeks view, or `{competencies}` in entry templates). Only the competency labels are public; who brings them and who may train others stays internal. Trainee places do not count.
- **Notifications.** A bell next to the profile picture shows unread notifications. People with `notifications.send` write messages to one or more roles under Directory → Messages (choosing roles also needs `roles.read`). The app also notifies by itself: lab-rules confirmers when someone requests a signature, staffing roles when an open-day period opens for sign-up, supervisors when a supervisor place within the next 14 days becomes free, and a job's operator when its run ends.
- **Hide a run from signage.** On a running run, "Hide this run from signage screens" removes the machine, its status and its camera from every display until the run ends. Each new run starts visible again. Job editors and the job's operator or customer can set it.
- **Open-day minimum per role.** A role with a staffing level can set its own minimum open days per semester. Empty uses the general setting; with several such roles the lowest value applies.
- **Colour picker.** Every colour field (branding, signage zones, calendar colours, scene background, material colour) has the system colour picker next to the hex value.
- **All time in the cashbook.** Payments show everything from the beginning by default; the other periods stay available in the filter.
- **Held check-in until the Lab Rules are signed.** Someone whose role requires signed Lab Rules and who has not signed the current revision is not checked in but held. The tablet explains what to do and lists them under "Waiting for Lab Rules"; a supervisor confirms the signed document on the Attendance page and the person is checked in from then on. Holds lapse at midnight.

### Changed

- **Entrance terminal for touch tablets.** Large check-in and check-out buttons, a PIN keypad, a presence list beside the actions, check-out by tapping one's name when the device allows public checkout, and an idle reset that clears half-entered sign-in details.
- **Attendance page.** Key figures, held check-ins with Lab Rules confirmation in place, assisted check-in by name search instead of person ID, and a searchable presence table with check-out and void in the row menu. Visitor hours are no longer shown.

### Fixed

- **Dashboard buttons and links.** Notices with an action (for example "Sign up as supervisor") held on to the keyboard focus and scrolled the page back to themselves on every click, so links further down the dashboard did nothing. Such notices no longer trap focus, here and on other pages.
- **Tooltips and menus are no longer cut off** by tables, tiles and dialogs: tooltips, toggletips, copy buttons and dropdown menus are placed above the page.

## [0.8.5] - 2026-10-22

### Upgrade notes

- Migration 00065 adds custom signage layouts, font assets and announcement body formats. Existing scenes, templates and publications keep working unchanged. API: `SignagePlayerManifest` has `customLayouts` and `layoutsVersion` 2, scenes carry `customLayoutId`, live data and `GET /signage/calendar` carry `calendar` and events `endsAt`, announcement templates and rendered messages carry `bodyFormat` and `bodyCss`. Republish displays to use the new features.
- Migration 00066 renames the wiRef template placeholders to English: `{{organisation}}` → `{{organization}}`, `{{kontaktperson}}` → `{{contact_person}}`, `{{bestellreferenz}}` → `{{purchase_order_reference}}`, `{{anforderungsnummer}}` → `{{request_number}}`, `{{auftragsnummer}}` → `{{order_number}}`, `{{summe}}` → `{{amount_to_invoice}}`, `{{freigegeben_von}}` → `{{approved_by}}`, `{{datum}}` → `{{approved_on}}`. Saved texts are rewritten and keep working; the settings version moves on, so an editor left open over the upgrade must reload. The old names are rejected when saving (422 `wiref_template_invalid`); configuration files exported by 0.8.3 and 0.8.4 still import, their placeholders are renamed on import.

### Added

- **Custom signage layouts.** Content → Layouts creates layouts as a grid (columns and rows with weights, zones drawn over cells) or with free rectangles (drag, resize, overlap, stacking order). Scenes can use them like built-in layouts; removing a zone warns which scenes lose a widget.
- **Styling for every signage widget.** Text and background colours, background opacity, padding, corner radius, border, font size and family, alignment.
- **Markdown and HTML/CSS in signage text.** Text widgets, open-day, event and agenda lists and announcement template bodies can be written in Markdown or HTML with CSS. Scripts and unsafe markup are removed; the CSS only affects its own box.
- **Uploaded fonts.** WOFF2 fonts can be uploaded under Media and used in widget styles and CSS.
- **List entry templates.** Open-day and event lists format each entry from one template with placeholders such as `{date}`, `{start}` and `{title}`; up to 20 entries.
- **Agenda widget** listing open days and events together, and a **calendar widget** (month or weeks) showing public holidays, breaks, open days and events, each switchable with its own colour.

### Changed

- **wiRef PDF and mail list the payments.** Below the totals, the PDF has a Payments table with every payment that still counts towards the order: payment ID (`P-…`), date, method (cash, card or the wiRef invoice settlement) and amount. The mail shows the same rows. Refunded or corrected payments are left out; payer, recorder and card terminal references are not included.
- **wiRef PDF header like the application header.** The compact logo sits on the left, beside it the organization name in capitals above the display name. The bundled default logo is now shown as well (only SVG logos are still omitted).

## [0.8.4] - 2026-10-22

### Upgrade notes

- Migration 00064 adds an optional Reply-To address to the wiRef delivery settings. It starts empty, so replies keep going to the mail sender address. API: `replyToEmail` is part of `WiRefDeliverySettings` and required in `UpdateWiRefDeliverySettingsRequest` (an empty string means none).

### Added

- **Reply-To for the wiRef mail.** Settings → Invoicing has an optional reply-to address. Replies from the accounting office go there instead of to the sender address of the email delivery settings, which is often an unread sending account. It is included in configuration export and import.
- **Detected spool tags when registering and editing spools.** Receive stock (new spool or reusable spool) and Register spool / Edit spool offer the NFC tags printers currently read, like Add identifier and Change filament. Register spool can set the NFC tag of the first fill; Edit spool adds a tag to the current fill. API: `CreateFilamentSpoolRequest` takes optional `identifiers` (not with `stockMode: empty`; a taken tag is refused with 409 `identifier_in_use`).

## [0.8.3] - 2026-10-22

### Upgrade notes

- Migration 00060 changes event data: `planning` events become `draft`, `archived` events become `completed` (closed date kept). Tasks `in progress` and `blocked` become open, cancelled tasks become done; priorities `high` and `urgent` become Important, the others are dropped.
- New permissions `events.signup` and `events.read_assignments`. The migration grants `events.signup` to every role with `open_days.signup` and `events.read_assignments` to every role with `open_days.read_assignments`, `events.staffing.manage` or `events.assign`. Review roles that should not let members join event shifts.
- `events.read` alone no longer shows draft events; drafts need `events.manage`, `events.staffing.manage` or `events.assign`.
- API: the `start-planning`, `return-to-planning` and `archive` event actions and the per-position endpoints under `/events/{id}/shifts/{shiftId}/requirements` are gone; positions are saved with their shift. `GET /events` is paged (`scope`, `search`, `ownerPersonId`, `page`, `pageSize`). Tasks use `important` instead of `priority`.
- Migration 00061: every account now has one email. For a person with an account, the person's email mirrors the account's login email. Accounts without a login email adopt their person's email when no other login uses it (plain ASCII addresses only; on a collision the older account wins). Accounts left without one are flagged on the person page with "Set login email". The migration also adds `people.member_since`, filled from the person's creation date.
- Migration 00062 moves connector runtime entries (`printer_event.ingested`, `printer_slot.spool_auto_mounted`/`_unmounted`, `machine_run.recorded`, `machine_job.recorded_run_updated`) from the last 30 days out of the audit log into the new per-connector activity log and deletes the older ones. Admin actions on connectors stay audited. It also adds update request columns for connectors and gateways.
- Migration 00063 adds the wiRef delivery settings and per-request delivery records.
- New permissions `invoicing.settings.manage`, `configuration.export` and `configuration.import`; existing roles do not get them (master does).
- API: `CreateAccountRequest.loginEmail` is required. `PATCH /people/{id}` rejects an email change for a person with an account (422 `email_managed_by_account`); use `PUT /accounts/{id}/login-email`. `memberSince` on the dashboard and supervisors is now a `date`, and `Person` has an editable `memberSince` (needs `people.update.all`).
- Update Core before the printer connector and streaming gateway. Web updates need the optional `updater` sidecar (Compose profile `updater`, Docker socket = root on that host, see `docs/hosting.md`); without it, update as before.
- Settings moved: OpenID Connect and SCIM are one page, Session policies and Managed devices are one page, printer connectors moved from the Machines page to Settings → Local services. Old links redirect.

### Added

- **wiRef delivery.** When an invoice request is approved and forwarded, Core emails it to the wiRef address set in Settings → Invoicing, as a branded mail with a PDF attachment, after the approval is committed. Subject, intro and closing of mail and PDF are editable with placeholders (`{{organisation}}`, `{{anforderungsnummer}}`, `{{summe}}`, …; English names since migration 00066) and optional fields can be switched off; preview, sample PDF and test mail included. The invoice request shows the delivery status and can be resent (`external_invoice_requests.approve`).
- **Configuration export and import.** Settings → Export & import downloads roles, device types and session policies, the machine catalog, inventory articles, pricing, open-day requirements, lab rules, surveys, visitor enrollment, branding and mail settings (never secrets) as one JSON file. Importing previews every change first; Overwrite makes each chosen section match the file (entries still in use are deactivated or kept), Insert only adds what is missing. The import runs in one transaction. See `docs/configuration-transfer.md`.
- **Updates from the web UI.** Settings → Local services → Versions and updates shows each connector's and gateway's version next to Core's and updates them to Core's version through the optional updater sidecar.
- **Connector activity log.** Connector diagnostics have an Activity log tab with the runtime events that used to fill the audit log (kept 30 days, at most 10,000 per connector).
- **Member since.** People have a "member since" date, used by the dashboard and the supervisors list. Administrators can edit it, independently of when the account was created.
- **Members join event shifts in the app.** With `events.signup` members see a helper view of each confirmed event and join or leave open places themselves; the same capacity, role, signup-window and overlap rules apply. Names of co-helpers need `events.read_assignments`.
- **Go-live readiness.** Events report whether the public page and helper signup are live and what is still missing.
- **Events screens redesigned.** `/events` pages events into Upcoming, Drafts and Past with search and an owner filter; organizers see status, public page, signup, staffing and overdue tasks, helpers see open places and their own shifts. An event opens as a participant view (programme by day, Join, a confirmed Leave) and organizers switch to an edit mode (`?mode=edit`) with Overview and next steps, a Go live panel, Programme with a positions editor, Helpers by shift and by helper, Tasks, a Public page tab with a live preview of the real page, and Files. Creating an event also creates its first session.
- **Public event page.** The visitor page has a Help us section with availability per position, a signup dialog with the one-time management link, and move/cancel for signed-in members.
- **Event helpers overview** grouped by helper, with unlinked public signups, suggested people and overridden overlaps.
- Shifts can be duplicated; new events can be created with their first session.
- Event documentation in `docs/events.md`.

### Changed

- One email per account: person pages show a single Email field. For account holders it is the login email.
- System mails (password reset, invitations, PIN setup, email verification, security notices, surveys) are branded HTML with a plain-text part, using the configured name, colour, logo and legal links.
- Reset, invitation and verification links carry the code, so it no longer has to be copied from the mail. The page reads it once and removes it from the address bar.
- Printer connectors and streaming gateways are managed together in Settings → Local services.
- Settings redesign: grouped overview (Access & identity, Lab operations, Communication & appearance, Sales & invoicing, Local services, Data), single sign-on (OIDC + SCIM) and devices & sessions on one page each, and a consistent frame for every settings screen. The Pricing tile is gone; pricing stays under Sales & payments.
- Events have four statuses: Draft, Confirmed, Completed, Cancelled. Helper signup (public and in the app) opens only for confirmed events; a public page can go live from a draft. Completed and cancelled events keep tasks and files editable.
- Event lists are scoped by date (upcoming, drafts, past), sorted by start and paged.
- Shifts are saved together with their positions in one request.
- Tasks are open or done with an Important flag and can be filtered by assignee, overdue and done.
- Toolchain and dependency updates, no behavior change. Go 1.26 to 1.27.3 (including golangci-lint 2.15.0), Alpine 3.24.2, Node 24 to 26 and nginx-unprivileged 1.31.6 in the images, and the pending backend, frontend and desktop-terminal packages. Frontend majors: TypeScript 7, ESLint 10, eslint-plugin-react-hooks 7, eslint-plugin-react-refresh 0.5, msw 3, @testing-library/jest-dom 7 and @types/node 26. typescript-eslint does not support TypeScript 7 yet, so linting runs against the side-by-side TypeScript 6 package.

### Fixed

- Self-service password reset sent no email to accounts that had a login email but had never set a password (for example invited, SSO- or PIN-first accounts). Failed deliveries are now logged (challenge and request IDs only).
- Dropdowns in dialogs (for example Assign role) were cut off by the dialog and showed only one option at a time.
- Order drafts can be finalized again without taking payment; the total stays outstanding and can be paid later.

## [0.8.2] - 2026-10-21

### Upgrade notes

- No migrations. Core and connector can be updated in either order; the recovery below needs both at 0.8.2.

### Fixed

- Printer connector: a connector that lost its local data (for example a container recreated without its volume) numbered its events from 1 again, and Core silently rejected every one, so no runs were recorded while the live status looked normal. Core now answers a reused sequence with the next free one, and the connector renumbers its pending events from there and logs a warning. Both sides stay compatible with 0.8.1. A connector that is already stuck needs Core 0.8.2 and connector 0.8.2; events it quarantined before the update stay quarantined.

## [0.8.1] - 2026-10-21

### Upgrade notes

- No migrations. Update Core before the printer connector: a 0.8.1 connector reports spool tag UIDs in its live status, which a 0.8.0 Core rejects.
- The printer live status now contains the RFID/NFC tag UID of each loaded spool (still no addresses, serial numbers, camera or network identifiers).
- Inventory sections are now Materials, Parts, Spools and Types & categories. Links to the former Filament and Consumables tabs open Materials (Filament with the FDM printing process filter).

### Added

- **Detected spool tags.** When adding an NFC tag to a spool, or tags in Change filament, staff can pick a tag a printer currently reads in one of its slots instead of typing it; tags already on a spool are marked. The printer setup shows each slot's tag UID with a copy button. `GET /printers/detected-spool-tags` needs `machines.read` and `inventory.read`.
- **New filament while filling a spool.** Change filament and Register spool can create the filament article in place and fill the spool with it as a purchase, so stock and cost stay tracked.
- **Recalculate a job's price.** Jobs with an incomplete price, or whose rates changed, can be recalculated from the current rates of their pricing group (`machine_jobs.edit`); the price adjustment stays applied. A charge that is outdated on an order can be refreshed from the job page.
- **Price lookup.** Sales & payments has a read-only price lookup: a machine run of some hours, optionally with material, or an amount of an inventory article, priced for every active pricing group (`pricing.read`).
- **Deleting articles.** Filament, consumables and parts can be deleted while nothing uses them yet (`inventory.manage`). An article with ledger entries, spool fills, run usages or order items cannot be deleted; the dialog says what still uses it.

### Changed

- Filament and consumables share one Materials table, told apart by the Process filter. Material types and part categories are managed in the new Types & categories section, in one combined list, instead of a dialog in the overflow menu.

### Fixed

- The Spools section of a filament article no longer drops empty spools: a finished spool waiting for a refill is listed under the material of its last fill.
- Printer connector: when the connector missed the end of a print, the next print's task ID left the previous run running forever; the open run now ends with an unknown outcome ("superseded").

## [0.8.0] - 2026-10-21

### Upgrade notes

- Migrations 00056–00059 run automatically when the production stack starts (inventory articles, inventory items on orders, role staffing levels and open day requirements, split card receipts).
- The filament product catalog is folded into the inventory articles and removed; its manufacturer, product and package data move onto the articles.
- The role flag "supervisor dashboard" becomes the role's _open day staffing_ level. Roles that had the flag become supervisor-level roles; set the trainee level on your trainee role in the role editor, and choose the role that "Make supervisor" assigns under Settings › Open day requirements.
- The production Compose stack now runs on its own network with a fixed subnet (`MAKERSPACE_NETWORK_SUBNET`, default `172.30.240.0/24`) and trusts it as forwarding proxy by default, so rate limits and audit records see real client addresses. Keep the frontend port bound to loopback or firewalled; set `MAKERSPACE_NETWORK_SUBNET` only if the default collides with a network on the host.
- nginx now sends a Content-Security-Policy, HSTS and further security headers; an external proxy or CDN should pass them through.

### Added

- **Personal dashboard.** The landing page is about the signed-in person: next open day or shift with one info box, semester progress against the open-day minimum, coming-up open days and event shifts (open days can be left), all-time statistics (jobs and success rate, material printed in Benchys, machine time, favourite machine, open days and shifts staffed), recent jobs and orders, a jobs-per-month chart and the lab-rules status. Sections follow the person's permissions; guests see their lab-rules status and the next open days ([docs/staffing-and-dashboard.md](docs/staffing-and-dashboard.md)).
- **Open balance and paying your own orders.** The dashboard shows unpaid orders and own priced jobs that are not on an order yet, with the sum (also at €0.00). "Pay now" pays everything or a selection in one step: jobs go onto one new order, and every selected order is paid in full with cash, card or split, recorded under your own name. A card slip that covers several orders is stored as numbered receipts sharing the terminal reference.
- **Semester staffing.** Roles carry an open day staffing level (supervisor or trainee). Settings › Open day requirements holds the minimum open days per semester (default 2), the open days as trainee before someone counts as ready (default 3) and the role a promoted trainee gets. Being signed up is enough to reach the minimum; supervisor and trainee places both count; only empty supervisor places make an open day short-staffed.
- **Supervisor staffing page.** Four key figures (below minimum, lab rules not signed, ready for supervisor, no profile picture) filter the member table, which shows role and trainee progress, lab rules, open days this semester, status and last open day, with pagination. "Make supervisor" promotes a trainee by hand.
- **Inventory articles.** Inventory is organised by article kind: filament, consumables and parts, each with variant, manufacturer, sale price, package size, storage location and notes. "Receive stock" books purchases onto existing or new articles (and new spools), with suggestions from earlier entries; material types and categories are managed in one dialog.
- **Selling from stock.** Orders can contain inventory items ("From inventory…"). Finalizing an order books the stock out, reversing or replacing it books the stock back, and an order that would go below zero is refused with `insufficient_stock`.

### Security

- Login throttling can no longer lock everyone out: a full limiter table evicts the least recently active entry instead of refusing new clients, and every credential check also has a per-client limit.
- Password and PIN hashing runs outside database transactions with bounded concurrency, so parallel logins cannot exhaust memory or the connection pool.
- PIN attempts pass an atomic in-memory gate before the persistent back-off, and the persistent back-off starts over after 15 quiet minutes.
- Which API operations need a staff session is derived from the OpenAPI contract instead of hand-kept path lists; every API response defaults to `Cache-Control: no-store`; rate-limited responses carry the `Retry-After` of the limiter that fired.
- nginx sends a Content-Security-Policy without inline scripts and with `frame-ancestors 'none'`, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` and `Cross-Origin-Opener-Policy`.
- Go 1.26.10, pgx 5.9.2 and x/net 0.60.0 close the vulnerabilities govulncheck reported as reachable; vulnerable transitive frontend packages are pinned to patched versions.
- GitHub Actions are pinned to commit SHAs; CI runs golangci-lint, govulncheck and `pnpm audit`, and Dependabot proposes weekly updates.

### Changed

- The code base follows a written style guide ([docs/styleguide.md](docs/styleguide.md)): golangci-lint and Prettier in CI, typed enums for domain states, shared helpers, all SQL in sqlc, large files split by topic. The design prototype, plan documents and the old review report were removed; open points are in [docs/known-limitations.md](docs/known-limitations.md).

### Fixed

- Several Carbon colour tokens had no value in the default theme (for example the text on selected read-only access buttons in the role editor was dark on the primary colour); styles now use Carbon's Sass tokens with fallbacks.
- Clearing a printer connector's events compared timestamps from two different clocks, so an event arriving right after clearing could stay hidden.

## [0.7.2] - 2026-10-20

### Fixed

- Open days: the calendar of the period and academic-break date ranges no longer snaps back to the start month or drops a picked date, so ranges spanning months can be picked with the mouse.
- The browser reported session activity on every click instead of at most once a minute, re-rendering the whole page each time.
- Printer connector: an artifact upload Core rejects with 404 or 409 (assignment ended, run unknown or deleted, configuration changed) is quarantined and its staged 3MF deleted, instead of being retried until it expires. Artifact delivery failures now log Core's HTTP status and error code.

## [0.7.1] - 2026-10-20

### Fixed

- Streaming gateway: `ACME_DNS_PROPAGATION_WAIT` (for example `60s`) replaces the gateway's own DNS propagation check by a fixed wait before Let's Encrypt validates, for networks whose router intercepts or caches DNS on port 53 and kept the certificate request "waiting for DNS record propagation".
- Release images report their version (they reported `dev`): the release build passes `VERSION` to the image builds.
- go2rtc in the streaming and local-services stacks no longer logs a tini warning at start.
- Releases finish when their validation is skipped because CI already passed on `main`: the public-image check and the GitHub Release used to be skipped as well.
- Integration tests no longer fail in CI on Linux (credential expiry times are stored with microsecond precision; package-level database tests use isolated schemas).

## [0.7.0] - 2026-10-20

### Upgrade notes

- Migrations 00051-00055 run automatically when the production stack starts (signage, managed-device mode `signage_player`, streaming gateways, gateway hardening, connector deletion).
- The printer connector's Compose project is now `makerspace-connector` (was `makerspace-printer-connector`), so an existing connector starts with a new, empty data volume and must enroll again: create a new enrollment secret for it in Core (Machines › Connectors › New enrollment secret) and put it into `.env` as `CONNECTOR_ENROLLMENT_SECRET`. The old volume `makerspace-printer-connector_connector_data` can be removed afterwards.
- Enrollment secrets come from `.env` (`CONNECTOR_ENROLLMENT_SECRET`, `STREAM_ENROLLMENT_SECRET`) instead of Docker secret files; `*_SECRET_FILE` still works as a legacy fallback.
- Use the new release bundles per stack (Core, printer connector, streaming gateway, local services) and follow [docs/hosting.md](docs/hosting.md).

### Added

- **Digital signage.** Displays run a separate, lightweight player web app at `/player/` in a kiosk browser and are paired with a six-character code shown on the screen. Scenes are built from zone layouts with widgets (image, video, slideshow, text, QR code, clock, machine status, live camera, open days, events, announcement) and a background colour or image; playlists rotate scenes; an ordered rule list per display ("when … show …": time windows, printing machines, active announcements, unavailable live data) decides what plays, with the default playlist as fallback. Content is published per display as an immutable revision. Announcements are templates with typed fields and `{placeholders}`, started for all or selected displays and shown wherever a scene has an announcement widget. The player works offline: a service worker caches the shell, the published revision and its media, and a new revision only activates once everything is cached. Displays can be revoked or deleted in any state; a deleted display shows a new pairing code. Previews use the real upcoming open days and events. New permissions `signage.read`, `signage.manage`, `signage.content.manage`, `signage.publish`, `signage.override`; optional `SIGNAGE_PAIRING_ALLOWED_CIDRS` limits who may request pairing codes ([docs/signage.md](docs/signage.md), [docs/signage-player.md](docs/signage-player.md)).
- **Live printer cameras.** A streaming gateway in the makerspace network restreams Bambu Lab H2D and X1 Carbon cameras (verified on both) to signage displays with go2rtc over WebRTC, with an MSE fallback; video never passes through Core. Players get short-lived signed tickets only for cameras their published content uses; camera widgets can be limited to chosen machines, and displays visible from outside need explicit consent (`allowCameraOutside`). The gateway can obtain and renew its own Let's Encrypt certificate (DNS-01 via Cloudflare: `ACME_EMAIL` and `CLOUDFLARE_DNS_API_TOKEN`) or use certificate files in `./certs`. Settings › Local services manages gateways and camera assignments; new permission `local_services.manage` ([docs/streaming-gateway.md](docs/streaming-gateway.md)).
- Printer connectors and streaming gateways can be deleted in any state (`DELETE /printer-connectors/{id}`; recorded runs and printer errors are kept without the connector reference) and re-enrolled while active: a new enrollment secret keeps the entry with its assignments or cameras, the running daemon keeps working until the secret is used. A daemon given a different secret in `.env` enrolls again on its own, and its log now names Core's HTTP status and error code and explains a rejected credential.
- `DELETE /machines/{id}` (`machines.manage`, plus `printer_connectors.manage` for a connected machine; expected version) deletes a machine with its printer setup and connector assignments. It refuses with `machine_in_use` while jobs or runs exist (retire the machine instead) and with `machine_has_mounted_spools` while a spool is mounted.

### Changed

- Hosting is four Compose stacks with fixed project names and one guide, [docs/hosting.md](docs/hosting.md): `makerspace-core`, `makerspace-connector` (`printer-connector/`), `makerspace-streaming` (`streaming-gateway/`) and `makerspace-local-services` (`local-services/`, connector and gateway on one host). Each has its own `.env.example`. Every release attaches a Compose bundle per stack and publishes the `streaming-gateway` image.
- New development commands `make dev-connector` and `make dev-streaming` (each prepares its `.env`, checks enrollment or explains the next step, builds and starts; `-logs` and `-down` variants). Removed: `dev-printer-connector`, `dev-printer-connector-detached`, `dev-local-services*`, `build-local-services`, `local-services-up/down/logs`.
- Faster CI and releases with the same checks: Go images cross-compile instead of building and testing under QEMU, the frontend builds once natively, Docker layers and Playwright browsers are cached, end-to-end tests run in three shards, and a release skips repeating the validation when CI already passed on `main` for exactly the tagged commit.

### Security

- Raw binary uploads (connector artifacts, event files, profile images, branding assets, Laborordnung PDFs, signage media) are no longer read into memory by the request validator before authentication, which let unauthenticated clients force large allocations.

### Fixed

- Editing a machine failed every time: request validation rejected `expectedVersion` because `UpdateMachineRequest` extended the closed `CreateMachineRequest` through `allOf`.
- The same validation error broke editing open days, academic breaks, event sessions, shifts, requirements, task lists and tasks, surveys and session policies, and signing up for an event while signed in. These request schemas are spelled out now, and a spec test rejects request bodies whose closed `allOf` members would refuse each other's fields.
- Connecting a printer after it was set up offered only the simulator: the connection step now uses the live adapter of the printer's model (Bambu Lab H2D/X1C) with IP address, serial number and LAN access code.
- The printer's serial number is taken from the machine's external identifier until it is edited, so the same value is not typed twice.
- A failed or timed-out connection test can be repeated with Test again, and changing a connection field asks for a new test instead of keeping the old result.
- The section switcher in table toolbars no longer jitters while hovered.
- The jobs list and a machine's jobs refresh every 10 seconds, so runs reported by a connector appear without a reload.
- Replaying an already used connector enrollment with the same credential no longer fails with a server error.

## [0.6.0] - 2026-10-19

### Added

- Directory: the People group becomes Directory with People, Organizations and Staffing. Organizations get an invoice address, a contact person and informational members (migration 00045), their own list and detail pages, and member endpoints guarded by `organizations.read`/`organizations.manage`. The job form suggests the organization when the person belongs to exactly one.
- `DELETE /organizations/{id}` (`organizations.manage`, expected version) refuses with `organization_in_use` while jobs, orders or invoice requests refer to the organization; members, the pricing assignment and invoicing requirements are deleted with it.
- Material types with per-type prices (migration 00046): each legacy category and unit becomes a material type, materials and pricing rules link to it, and the free-text colour becomes a colour name and hex. Inventory gets a Material types section, statistics report by type, and printer setup warns when a mounted spool's colour differs from the colour the printer reports.
- Processes per machine type (migration 00047): `fdm_printing`, `embroidery`, `uv_printing`, `laser_cutting`, `vinyl_cutting`, `other`. Adds the `cm2` unit, run measures (stitches) and a `machine_measure` pricing rule billed per 1000 stitches. The run form and material picker follow the machine's process; the backend only accepts materials of that process.
- Mass edit in the jobs table: delete, create separate jobs, create one combined job, or attach to a job. Each bulk endpoint runs in one transaction with per-item version checks and audit events and refuses the whole request with `bulk_blocked` when any item is blocked.
- Shared filter panel for every filtered table, a section switcher in the Machines and Inventory toolbars, and links on job, run, order, payment and spool references.
- Sales frontend: overview, orders with Open/Paid/Cancelled sections and a review-jobs flow, order detail with the invoice approval section (copy for wiRef, return, forward), record payment with an invoice option, the cashbook with period filter, cash movements and semicolon CSV export, and a pricing page with the rates matrix, groups and role mapping.
- Orders expose their latest invoice request in any state and requests can be listed per order; a cancelled request stays visible with a "Request invoice again" action. Orders and payments get a printable receipt.
- Invoice request approval: draft, awaiting approval, issued. New permission `external_invoice_requests.approve` (edit, return for correction, forward to wiRef, cancel). Forwarding settles the order with an `external` "Invoice (wiRef)" payment; an invoice can be requested for partially paid orders (`alreadyPaid`).
- Cash movements (`/cash-movements`, `cash_movements.read/record`) and the expected cash in the register (`GET /payments/cash-register`, cash only).
- Role based pricing: `/pricing-role-groups` maps roles to pricing groups by priority.
- `createdBy` on orders and `recordedBy` on payments, cash movements and request events.

### Changed

- Decimal fields (quantities, areas, ink, weights, prices, amounts) keep what is typed and accept a comma: "1,5" and "1.5" both mean 1.5, thousands separators are rejected, and integer fields explain instead of clearing.
- Cash and card payments are frozen while an invoice request awaits approval or is issued. Pricing resolves job override, then organization, then role mapping by priority, then default.
- The sidebar reads Dashboard, Workshop, Sales & payments, Operations, Directory. Organization admin moved out of Settings; external invoicing and the machine-logbook configuration page redirect to their new homes.
- Machine types use a process instead of the `printer` flag; printer setup, connectors and spools stay FDM-only.

### Fixed

- Section switcher tabs point at real panels, the jobs batch bar and pricing tables no longer make narrow pages scroll sideways, and a paid order no longer says payments are paused.
- Signing in after someone else signed out lands on the dashboard instead of the previous person's last page.

### Removed

- Counter sales (`/counter-sales`, `/counter-sales/preview`, the counter sale page), the invoice request state `ready`, manual `external` payments and the per-person pricing group assignment (migrations 00048-00050; 00048 refuses to run while submitted or issued requests have an unpaid order).

## [0.5.0] - 2026-10-16

### Added

- Machines & Jobs redesign: navigation is Overview, Jobs, Machines, Inventory, Statistics. A unified work-items list shows jobs and unassigned recorded runs, machines show derived availability and the current run, and the overview and statistics gained running/needs-outcome/unlinked counts, a previous-period comparison, runtime buckets, and material cost versus losses (statistics `to` is exclusive).
- Optional job title. Start, end, runtime, running status, and outcome are derived from the job's runs.
- Price adjustments (fixed, discount percent, discount amount, multiplier) that are re-applied on recalculation, with a stored effective price.
- Machine runs replace prints: a job consists of one or more runs (manual, or recorded by a machine connector with display IDs `R-YYYY-NNNNNN`) for any machine type. Recorded runs can be created into jobs, attached to or detached from jobs on the same machine (also while running), and several runs per job are supported. Connector-reported material is consumed automatically when a run ends.
- Filament spool fills and kinds (reusable or single-use), change filament, finish, cleanup of archived single-use spools, registration of empty reusable spools, and a filament product catalog.
- `make seed-dev` demo data, repeatable on top of existing data: it reuses compatible shared records, creates missing roles, an open day period and a master when needed, and accepts `SEED_ARGS` (`-seed`, `-actor-email`); `make test-integration` uses the dedicated `makerspace_test` database.

- Printer setup backend: machine types have a `printer` flag, printer profiles a `model` and spool input units a `nozzle`; `PUT /machines/{machineId}/printer/setup` saves the profile, units and slots atomically (retiring removed slots, refusing to remove mounted ones) with one audit event; migration 00043.
- Live printer status: the connector reports its newest normalized snapshot per printer (`PUT /printer-connector/self/assignments/{assignmentId}/status`) and `GET /machines/{machineId}/printer/live-status` returns it. The snapshot covers job, temperatures, nozzles, AMS and external spool trays, errors and Wi-Fi signal, never network identifiers.
- Bambu H2D external spool holders (`vir_slot` 254 and 255) are reported as units, resolved as the active tray, and observed like AMS trays.
- Standalone Bambu Lab H2D and X1 Carbon LAN adapters with encrypted assignment credentials, authenticated MQTT telemetry, read-only implicit FTPS artifact retrieval, durable SQLite event and artifact queues, reconnect recovery, and safe unknown-state closure after prolonged disconnects.
- Private, hash-deduplicated 3MF artifacts with bounded ZIP validation, structured filament metadata, preview extraction, protected downloads, and exact-hash association with planned jobs.
- Live printer setup and diagnostics for H2D and X1C, including model-specific connection settings, write-only access-code rotation, AMS and external-spool topology, exact-RFID spool detection, and optional automatic spool mounting.
- Multi-material run reports with per-filament provenance, conservative interrupted-print G-code estimation, staff mapping of unresolved report lines to physical spools, and atomic inventory and pricing updates once a run belongs to a job.
- `make dev-printer-connector` and `make dev-printer-connector-detached` for running the standalone connector in development.

### Changed

- The printer connector polls its configuration and sends its heartbeat every 10 seconds (was 30), and fetches the configuration immediately when a heartbeat shows a newer revision.
- Automatic job ingest is gone, so connector data no longer creates unconfirmed jobs. The final-price override became a price adjustment.
- Spool lifecycle `retired` became `archived`. Ledger entries and job usages keep spool and fill snapshots.
- Counter sales always create a new manual job; confirming an existing review job is gone.
- Job timing, runtime, material usage, and outcome are derived from runs; material usage moved from jobs to runs. Concurrent run operations return 409 `retry_conflict` on rare conflicts. Migration 00041 contains the schema change.
- API: `/machine-runs` (list, detail, patch, delete, usages, cancellation, job attach/detach/create) and `POST /machine-jobs/{id}/runs`; the overview response adds `unassignedRuns`; the ledger kind is `machine_run_consumption`.
- Printer pages, run details, and connector diagnostics refresh while open; high-volume material-slot observations are summarized instead of flooding the visible machine-event history.
- Recorded-run titles prefer the printer project name. Filament estimates appear as soon as the archived 3MF is available and remain separate from final applied consumption.

### Fixed

- H2D and X1C completed prints retain every reported material instead of collapsing to one filament, and mounted spool evidence is resolved by exact AMS unit and slot rather than tray number alone.
- Interrupted multi-material prints stop accounting at the latest trustworthy layer and progress checkpoint, so later colors that were never reached are not charged.
- X1C single-nozzle filament changes use the printer's filament-to-AMS mapping instead of assigning consumption to whichever tray was current when the terminal snapshot arrived.
- Connector diagnostics tolerate newly arriving event groups, and machine, printer, run, and event views update without a manual page reload.

### Security and privacy

- MQTT, FTPS control, and FTPS data connections validate the vendored Bambu printer CA, certificate validity, full chain, and the configured serial number without an insecure verification bypass.
- Artifact uploads stream into private storage with size, hash, archive, path-traversal, entry-count, expansion, and image limits; printer logs, access codes, network identifiers, RFID values, and private 3MF fixtures remain outside the repository.

### Known limitations

- The connector is monitoring and ingestion only: it does not start, pause, resume, cancel, upload to, or otherwise control a printer.
- H2D and X1C LAN behavior has been exercised against the available printers, while H2D same-hotend AMS color switching remains hardware-unverified and intentionally stays unresolved when the observed route history is ambiguous.

### Removed

- `POST /machine-jobs/automatic`, the review-queue UI, and the final-price override endpoint and schemas.
- `/prints` and its subresources, `/machine-jobs/{id}/usages`, and `/machine-jobs/{id}/run-cancellation`, replaced by runs.
- Print submissions, print attempts, filament declarations, printer-event reconciliation, linking observed runs to attempts, and the review queue with job confirmation, including their tables, endpoints, and the `print_submissions.read`, `print_submissions.manage`, and `machine_jobs.review` permissions.

## [0.4.0] - 2026-10-05

### Added

- Configurable makerspace identity, colors, image assets, and legal content, with public branding applied consistently across authenticated and public pages.
- End-to-end event management for planning, sessions, shifts, staffing assignments, task lists, files, public event pages, and authenticated or token-based signups.
- Directory filtering and bulk actions, richer supervisor staffing views, and direct role assignment on Person records.
- Global academic-break administration for Open Day planning, including a permission-protected list API and period-aware management UI.

### Changed

- Open Day period creation now focuses on the period and date range, while academic breaks and schedule setup live in their dedicated management views.
- Open Day schedule editing, role administration, People, Members, machine-logbook, and settings screens use more compact Carbon workspaces and responsive interaction patterns.
- Role administration now centers one selected role at a time, with explicit none/self/all access controls and an integrated permission detail panel.
- Frontend delivery keeps charting behind its asynchronous boundary, serves compressed static assets with production-safe cache behavior, and enforces documented bundle budgets.

### Fixed

- Branding asset uploads are sent as binary request bodies so uploaded images are preserved correctly.
- Directory filters, supervisor assignment counts, Open Day date handling, and responsive table and toolbar behavior now remain consistent across API, desktop, and narrow-screen flows.

### Security and privacy

- Event, branding, People, role-assignment, and academic-break operations use registered permissions, service-layer authorization, and transactional audit behavior where data is mutated.
- Public event and branding responses expose only purpose-specific fields; private event files and signup capabilities remain protected by visibility rules and scoped tokens.

## [0.3.0] - 2026-10-03

### Added

- Administrative PIN configuration and permission-scoped removal of password, PIN, and OIDC authentication methods, with session revocation and audit events in the same transaction.
- Authentication-method usability reporting, optional manual PIN setup links when email delivery is unavailable, and accounts that can be created without a login method.
- Open Day schedule table and calendar views with date/time filters, bulk editing, reusable defaults, recurrence selection, lifecycle actions, and safer cancellation flows for published dates.
- Dedicated People and Audit Log navigation, Makerspace status details, and richer account, role, profile, and authentication controls on Person and Profile pages.
- HTU Graz Makerspace branding across the application shell and authentication flows, including responsive branded layouts and workshop imagery.

### Changed

- New accounts are active by default, while lifecycle status and authentication methods are managed independently; login email is now optional during account creation.
- Open Day planning and preview workflows are consolidated on the period page, with legacy schedule URLs redirected to the new editing mode.
- People, staffing, audit, settings, About, and Legal & Privacy routes and navigation now follow permission-aware, task-focused groupings while preserving redirects for previous URLs.
- The sign-in, password reset, invitation, email verification, and PIN enrollment experiences use the shared brand treatment and clearer access guidance.

### Fixed

- PIN enrollment no longer requires a Person contact email when an authorized administrator can securely pass on the one-time setup link.
- Password resets can restore an existing password identity without changing account state or roles, and authentication methods can be removed without artificial account-stranding conflicts.
- Permission labels, audit presentations, responsive administration layouts, and end-to-end coverage now reflect the reorganized workflows.

### Security and privacy

- Administrative authentication changes continue to require registered method-specific permissions, optimistic version checks, credential hashing, session revocation, and transactional audit records.
- Authentication identity details expose only safe display metadata and usability state; PINs, password material, and one-time challenges remain secret.

## [0.2.0] - 2026-09-23

### Added

- Assurance-aware password, PIN, and OpenID Connect authentication, account recovery, email verification, invitations, and session reauthentication.
- Managed-device identities and device-scoped permission grants.
- SCIM 2.0 provisioning and reconciliation, OIDC provider administration, and controlled visitor enrollment.
- Private profile images, Local/S3 file storage, versioned Lab Rules, and confirmation workflows.
- Open Day lifecycle management, calendar scheduling, recurrence previews, academic breaks, self-registration, assignment management, and supervisor staffing views.
- Machine logbook catalogs, jobs and ingestion, pricing snapshots, billing, inventory ledger, and operational statistics.
- Expanded People and Account administration plus a redesigned Role permission matrix.
- A permission-gated Activity log with current safe display labels, actor filtering, cursor pagination, and privacy-preserving fallbacks.

### Changed

- Audit events now retain durable user, system, or historical-unknown actor types and expose only allowlisted current labels without storing name snapshots.
- Access logs now correlate authenticated Account IDs and authentication methods, share trusted-proxy client addresses with authentication throttling, omit unmatched raw paths, and quiet successful health probes.
- The OpenAPI contract, generated clients, authorization model, deployment documentation, production Compose bundle, and CI validation were expanded for the new modules.
- Frontend tests use bounded concurrency and realistic UI interaction timeouts for stable execution on CI runners.

### Fixed

- Open Day scheduling now rejects ambiguous or nonexistent local times, validates slot bounds, and preserves assignment labels safely.
- Visitor enrollment pins the applicable immutable Lab Rules version throughout the workflow.
- OIDC linking requires recent proof, SCIM reconciliation preserves provisional identities, and anonymous recovery remains enumeration-safe.

### Security and privacy

- Mutations and audit records remain transactional, deleted users and resources do not leave retained display-name snapshots, and sensitive credentials, request bodies, headers, and arbitrary path values remain excluded from logs.
- Role delegation, assurance requirements, device scopes, last-master protection, and sensitive Person-field permissions are enforced server-side.

## [0.1.0] - 2026-09-18

- Introduced managed devices and scoped permissions alongside the initial People, Account, Role, Open Day, and audit foundations.

## [0.0.1] - 2026-09-14

- Initial development release.

[0.18.2]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.16.3...v0.17.0
[0.16.3]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.16.2...v0.16.3
[0.16.2]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.8.5...v0.9.0
[0.8.5]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Basmatireis/Makerspace-Core/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Basmatireis/Makerspace-Core/releases/tag/v0.1.0
[0.0.1]: https://github.com/Basmatireis/Makerspace-Core/releases/tag/v0.0.1
