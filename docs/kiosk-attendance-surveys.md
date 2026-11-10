# Kiosk, attendance, session policies, and surveys

The entrance kiosk is an ordinary registered ManagedDevice with `terminal_enabled`, an explicit SessionPolicy, attendance assurance settings, check-out options (`allowTapCheckout`, `offerSurveysAtCheckout`, `kioskResetSeconds`), and declared hardware capabilities. The public `/kiosk` route accepts only a valid managed-device credential. It never consumes an existing staff Session, so public requests cannot inherit staff permissions. Staff sign-in creates a Session bound to that device. Server authentication rejects that Session without the same active device identity, and idle or absolute expiry makes it unusable before the browser redirects to the policy destination.

Unregistered browsers use the one default SessionPolicy and are never inserted into `managed_devices`. Sessions snapshot the selected policy ID/version, idle interval, absolute deadline, post-session destination, and optional device ID. User activity extends idle expiry through `POST /auth/activity`, capped by the absolute deadline. Policy or device-policy changes revoke affected active Sessions transactionally.

Attendance is separate from authentication. Password or PIN verification at the kiosk returns a verified Person/Account/assurance result without creating a Session. Check-in locks the enabled Account and Person, prevents two open Visits, and evaluates the person's Lab Rules state. When they must confirm the current version, the check-in without a decision answers 409 `lab_rules_confirmation_required` (role in `blocking` mode) or `lab_rules_confirmation_suggested` (role in `warning` mode) and records nothing. The kiosk then shows the current version (`GET /terminal/lab-rules`, `GET /terminal/lab-rules.pdf`, device-authenticated; only the current effective version is ever served) with a checkbox and repeats the check-in with `confirmLabRulesVersionId`: the confirmation (method `kiosk`) and the admitted Visit commit in one transaction, and an id that is no longer the current version answers 409 `lab_rules_version_outdated`. A `warning` role may choose "Later" (`deferLabRules: true`) and is admitted with admission decision `warning`. A supervised check-in of a `blocking` person without the current confirmation answers 409 `lab_rules_confirmation_required` (they confirm themselves at the kiosk or in the app); `warning` roles are admitted with a warning. Supervised operations use registered attendance permissions; voiding requires `attendance.correct`, an optimistic version, and a reason.

Completing visitor enrollment on the kiosk counts as arriving, in the enrollment transaction (check-in method `enrollment`, assurance `low`, checked in by the new account, on the enrollment device). New visitors carry no initial role of their own: the database gives every new person the Visitor membership role (see [staffing-and-dashboard.md](staffing-and-dashboard.md#membership)), and enrollment grants nothing else. When the Visitor role asks for the Lab Rules, the visitor must tick "I have read and accept the Lab Rules" (`labRulesAccepted`, 422 otherwise); enrollment records the confirmation (method `enrollment`) of the pinned version and checks them in with admission `admitted`. If another version became current meanwhile, the submission is refused with 409 `lab_rules_changed` and the kiosk starts over. The enrollment result reports `attendance: checked_in`; the visitor does not check in again.

## Visits are anonymized at check-out

A visit keeps its person only while the person is in the lab: the open visit is what presence, check-out and the Lab Rules admission need. Every check-out (identified at the kiosk, tapping a name, by a supervisor) does this in its one transaction, after it raised the `check_out` notification trigger and created the post-visit survey invitation or the tablet's offer:

1. the visit is rolled into `attendance_daily_statistics` (UTC days): visitor count and unique visitor on the check-in day, seconds per day it spans, completed count and duration on the check-out day;
2. `people.last_visit_on` is set to the UTC date of the check-in (only the date of the last completed visit is kept per person, no history);
3. the visit row is deleted.

A person counts as a unique visitor of a day unless their `last_visit_on` already is that day. Peak occupancy is recorded as a candidate after every check-in and before every check-out (the number of open visits at that moment). Voiding deletes an open visit; it adds nothing to the statistics. `GET /visits` therefore lists only open visits, and `GET /attendance/statistics` sums the daily statistics of every day the period touches and adds the open visits live; `uniqueVisitors` is the sum of the daily unique visitors. Migration 00131 rolled the completed and voided visits that existed then into the statistics, filled `last_visit_on` and deleted them.

Survey invitations and tablet offers keep a random check-out reference in `visit_id` (not the visit's ID, which appears in URLs and logs) only to match the invitation and the offer of one check-out; an open offer carries `person_id` for its 15 minutes, cleared when it is consumed and deleted with the offer when it expires.

**Audit.** Ordinary check-ins and check-outs (kiosk, tap, enrollment, supervised check-in) write no audit event: while the person is here the visit is the record, and afterwards nothing personal is kept. Only corrections by the team are audited, `visit.supervised_check_out` (someone checked out another person) and `visit.voided`, with the acting account but without the visit's ID, the person or the reason. For these corrections the rule that a mutation and its audit event commit in one transaction still holds; check-ins and check-outs have no audit event to commit. Migration 00131 deleted the earlier `visit.checked_in`, `visit.checked_out`, `visit.public_checkout` and `visit.supervised_check_in` events and removed the visit ID from the earlier corrections.

Public presence exposes only first name plus surname initial and Visit ID. The kiosk refetches presence every 10 seconds. Checking out with PIN or password is always possible on a kiosk. Checking out by tapping a name in the presence list is an additional option, available only when the device has `allowTapCheckout` (otherwise `POST /terminal/presence/{visitId}/check-out` answers 403); the former `checkoutMode` (`verified`/`public_tap`) was replaced by this switch, and migration 00119 turned every `public_tap` device into `allowTapCheckout = true`. Completed visits are not kept (see [Visits are anonymized at check-out](#visits-are-anonymized-at-check-out)); interactive statistics are limited to a 90-day range.

Surveys (drafts, conditional questions, share links, post-visit invitations, results and CSV export) are documented in [surveys.md](surveys.md). Checkout creates eligible invitations in the check-out transaction, before the visit is deleted.



The web bridge contract is versioned and selected at runtime. The Tauri shell injects a private loopback bridge configuration; it reports capabilities and emit only technical credential events (`nfc`, `qr`, or `barcode`). The web application and Core own resolution and business rules. The current desktop implementation supports PC/SC NFC UID reads; concrete USB drivers and other hardware adapters remain separate deployment work.

## Kiosk device settings

A kiosk device (`managed_devices`) carries three check-out settings next to the assurance levels:

- `allowTapCheckout` (default false): also allow checking out by tapping a name in the presence list. Identified check-out (PIN or password, at the device's `checkOutAssurance`) is always possible.
- `offerSurveysAtCheckout` (default false): offer the check-out survey after a self check-out (below).
- `kioskResetSeconds` (15 to 600, default 60): idle time after which the tablet returns to its start screen. `GET /terminal/context` returns all three.

"Used as" (visitor kiosk, with staff, staff only) is a view over `allowedApplicationModes` and `terminalEnabled`; it has no field of its own.

## Check-out survey at the tablet

After a **self** check-out (PIN or password, not tapping a name, not a supervisor's check-out) on a device with `offerSurveysAtCheckout`, the check-out answer (`Visit`) carries `surveyOffer` when all of these hold: a published survey has an enabled `visit_checked_out` trigger with `askAtTablet`; the person has not switched "feedback at check-out" off (`person_notification_settings.ask_feedback_at_checkout`); and the survey's per-person cooldown allows it. The cooldown counts invitations and earlier tablet questions (`survey_ask_cooldowns`, written when an offer is made, so declining or answering also starts it). The trigger has no audience restriction today, so the offer goes to everyone who qualifies; there is no limit on the number of questions or on required free text.

`surveyOffer` holds `offerToken`, `surveyName`, `questionCount`, `anonymous`, `canAnswerNow`, `canSendByEmail` (the person has an e-mail address) and `expiresAt`. The token is opaque, 15 minutes valid, single use, bound to the check-out, the person, the tablet and the survey version, and only its digest is stored (`survey_offers`; consuming an offer clears its check-out reference and person; expired offers are deleted by the survey delivery loop, about every minute, and before each new offer). The device-authenticated endpoints, which answer 404 for an unknown, used, expired or foreign-tablet token:

| Endpoint | Effect |
| --- | --- |
| `POST /terminal/survey-offers/{token}/answer-now` | Returns the questions (`PublicSurvey` shape). The offer stays valid. |
| `POST /terminal/survey-offers/{token}/responses` | Stores the answers like an invitation redemption: anonymous surveys keep no person and no visit link, identified surveys link the person. Consumes the offer, cancels the visit's invitation. |
| `POST /terminal/survey-offers/{token}/send-email` | Makes the invitation due now (bypassing the delay) and consumes the offer. Works while the person's Surveys & feedback consent is off; the consent is not changed. 422 `no_email` without address. Audit `survey_offer.email_requested` (resource: the offer). |
| `POST /terminal/survey-offers/{token}/decline` | "No thanks": consumes the offer, cancels the visit's invitation. |
| `POST /terminal/survey-offers/{token}/never` | As decline, and sets `ask_feedback_at_checkout = false` (audit `survey_offer.never`). |

While an offer exists, the automatic e-mail invitation of that visit is postponed until the offer has expired. The automatic invitation (offered or not) is created only for people who granted the current text of the Surveys & feedback consent category.

## Consent at the kiosk

The answer of a tablet check-in also carries `consentRequired` and `consentCategories` (`id`, `name`, `description`, `basis`) while the person has consent categories unanswered at their current text. The tablet posts the answers to `POST /terminal/consents` (`visitId`, `answers[{categoryId, granted}]`): they are stored with place `kiosk` and the tablet as for the app (audit `notification_consent.answered`), only for the person of an open visit that was checked in at this tablet within the last 10 minutes; every other case answers 404.

## Visitor enrollment steps

The wizard at `/visitor-enrollment` has up to four steps:

1. **About you.** First and last name, a required email address (contact and the account's login email) and, on kiosks that can take or upload one, a photo. There is no phone field.
2. **Sign-in method.** When both methods are allowed, a switch chooses between "Email and password" (preselected; the address from step 1 is shown and can be corrected, and the invitation goes there) and "Login name and PIN". For a PIN the kiosk asks `POST /visitor-enrollment/login-name-suggestions` (`firstName`, `lastName`, enrollment context and CSRF header) for `firstname.lastname`, lower case with umlauts written out and accents dropped, with a random number appended when that name is taken (random, so the answer does not reveal which numbered names exist; 403 when PIN enrollment is not allowed). It creates nothing and answers 422 when no valid name can be built; the visitor may change the suggestion, and the submission checks the name again.
3. **Messages.** The consent categories from the enrollment state (`consentCategories`, the categories with basis `consent`), each with a No/Yes switch; nothing is preselected and Next works with everything off. The submission sends an answer per category in `consents`; they are stored with place `kiosk` and the kiosk device in the enrollment transaction (audit `notification_consent.answered`), so the next check-in does not ask again. The step is left out when no category needs consent.
4. **Lab Rules**, only when the Visitor role asks for them (see below).

The header links the imprint and privacy policy from the branding legal settings. On the kiosk and in visitor enrollment they open in a dialog on top of the page, because a kiosk has no way back from another website (the desktop app does not even open one): an internal document is shown as text, an external one in a frame with a QR code for reading it on a phone when the site refuses to be framed.

## Enrollment photo and on-screen keyboard

The "About you" step of visitor enrollment picks its photo source from the kiosk's effective capabilities (see [Managed devices](managed-devices.md)): `camera` shows "Start camera", `file_upload` shows the upload. After a photo is taken or chosen the visitor positions it under a round mask (drag, arrow keys, zoom slider 1x to 3x) and the visible square is uploaded as a 512x512 JPEG. With neither capability the photo is hidden and not required; the backend enforces this per device.

While the on-screen keyboard is open (the visual viewport is clearly smaller than the layout viewport and a text field has focus) the kiosk scrolls the focused field to the middle of the visible area and sizes its layout to the visible height, so the Next or submit button stays above the keyboard. The "About you" step then uses one column and hides the photo column and the progress header. The Lab Rules PDF modal is sized with `dvh` units to the visible screen; its pages scroll inside the modal while header and close button stay visible.

## Lab Rules in the frontend

- **App.** When the own status (`/auth/me` `laborordnungStatus`) has `actionRequired`, the application shell opens a modal with the current PDF (pdf.js, loaded lazily with the modal), an agreement checkbox and Confirm (`POST /laborordnung/confirmations/me`). In `blocking` mode it cannot be dismissed; in `warning` mode "Later" hides it until the page is loaded again (React state, nothing stored). The dashboard tile and notice link to `/lab-rules/confirm`.
- **`/lab-rules/confirm`.** Standalone page without navigation behind the session (signed-out people go to sign-in and return), the target of the "New Lab Rules" notification and e-mail. It shows the form, or "Nothing to confirm", "Already confirmed" or a no-published-version message, and a thank-you with a link into the app after confirming. A 409 `lab_rules_version_outdated` reloads the status and shows the new revision.
- **Kiosk.** A check-in answered with 409 `lab_rules_confirmation_required` (blocking) or `lab_rules_confirmation_suggested` (warning) opens the rules screen (`/terminal/lab-rules`, `/terminal/lab-rules.pdf`). "Confirm and check in" resubmits the same entries with `confirmLabRulesVersionId`; "Later" (warning only) resubmits with `deferLabRules`. The entries live only in that screen's state and are dropped on Back, after check-in and after 120 s without a touch.
- **Visitor enrollment.** The last step asks for "I have read and accept the Lab Rules" and sends `labRulesAccepted`; 409 `lab_rules_changed` reloads the state and returns to that step with a notice.
- **Staff.** Settings › Lab Rules › Confirmations lists who confirmed which revision and how (`laborordnung.confirmations.read`); the person page shows the latest five. The attendance page no longer has holds or a confirmation queue; assisted check-in of a blocking person who has not confirmed says they must confirm on the tablet or in the app first.
