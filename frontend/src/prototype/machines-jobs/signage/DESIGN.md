# Digital signage — prototype design spec

Frontend-only prototype inside the existing Machines & Jobs prototype shell (`frontend/prototype.html`).
Source concept: "Digital Signage für Makerspace Core – Gesamtkonzept" (19.10.2026). UI language: English, like the rest of the prototype.

## Decisions (agreed with the user)

1. **Scene editor = zone templates.** A scene picks one layout template (a CSS grid with named zones). Each zone holds exactly one widget. No free drag-and-drop, no layers, no undo stack.
2. **One priority list per display.** Schedules and event rules are the same thing: an ordered list of "When … show …" rules. The first matching rule wins; the display's **default playlist** sits fixed at the bottom. The UI always explains *why* something is on screen.
3. **Pairing by code.** An unpaired player shows a six-character code. Staff enter it in Core ("Pair display"). Backend-wise this is a managed device with a new mode `signage_player`; the UI never shows tokens.
4. **Publish per display.** Edits to scenes, playlists, rules and media are drafts. A display shows "N unpublished changes" and has one primary **Publish** action that creates an immutable publication. Players keep running the last publication.
5. Media reuse the existing files/storage module (no new storage concept in the UI, just a usage meter).

## Permissions (new, registered permission IDs)

| Permission | Allows |
|---|---|
| `signage.read` | See displays, content, media, health |
| `signage.manage` | Pair/rename/revoke displays, edit rules and default playlist |
| `signage.content.manage` | Edit scenes, playlists, upload/delete media |
| `signage.publish` | Publish a display |
| `signage.override` | Start, edit and stop announcements (the Announcements page is visible with `signage.read` or `signage.override`) |
| `local_services.manage` | Local services: enrollment secrets, compose bundle, revoke services |

Role presets: supervisor gets all. New preset **Content editor** (`signage.read`, `signage.content.manage`): can edit scenes/playlists/media, cannot pair, publish or change rules. Front desk additionally gets `signage.read` + `signage.override` (can start a "Closed" announcement). Controls without permission are hidden, never just disabled-without-reason.

## Navigation

New side-nav heading **Signage**: Displays (`/signage`), Announcements (`/signage/announcements`), Content (`/signage/content`), Media (`/signage/media`).
New side-nav heading **Settings**: Local services (`/settings/local-services`).
Fullscreen player route `/signage/play/:displayId` renders **without** the app shell (no header/side nav). `/signage/play/unpaired` shows the pairing screen.

## Screens

### Displays `/signage`
PageShell, description e.g. "3 displays · 2 online · 1 needs publishing". Primary **Pair display** (`signage.manage`).
DataTable columns: Name (+ location underneath), Orientation (Portrait 1080 × 1920), Status tag (Online green / Offline red with "last seen 2 h ago" / Syncing blue with %), Now showing (scene/playlist name + reason in secondary text, e.g. "Rule: H2D printing"), Publication (Up to date / "3 unpublished changes" warm-gray tag). Row → detail.

**Pair display modal**: code input (6 chars, upper-case, format hint "Shown on the screen"), name, location, orientation (Portrait/Landscape radio), resolution select, **Visible from outside** toggle (helper: "Camera zones then need confirmation; no customer data is ever shown"), default playlist. Success toast with link to the new display. Wrong code (e.g. anything not `K7F2QX`) → inline error "No screen is waiting for this code. Codes expire after 15 minutes."

### Display detail `/signage/displays/:displayId`
Header: name, location + orientation in description, primary **Publish N changes** (`signage.publish`, hidden when nothing to publish → show "Up to date" tag instead). Overflow: Open player, Rename, Rotate credential, Revoke, Delete (only when revoked).
Unpublished-changes `InlineNotification` (kind info) listing what changed (e.g. "Scene "Print live" edited · Rule added").

Two-column layout (stacks on narrow): left **Live preview** — scaled frame (correct aspect ratio) rendering the player for the current simulation state, under it "Now showing **Print live** — rule 1 *H2D or X1C printing* matched" and "Open fullscreen player" link. Right/below: Tabs.

- **Playback** tab: ordered rule list. Each row: priority number, condition summary ("Mon–Fri 08:00–10:00", "Any of H2D, X1C printing", "Announcement active"), arrow, target ("Scene Print live" / "Playlist Ads"), min. duration, an **Active** tag on the winning rule, enabled toggle, up/down buttons, overflow (edit, delete). Fixed last row "Otherwise: Playlist Ads" with an edit action. **Add rule** opens a modal:
  - Condition: Time window (weekdays checkboxes + from/to time) · Machine printing (machines multi-select, any/all) · Announcement active · Live data unavailable.
  - Show: scene or playlist (combo box).
  - For camera scenes and >1 printer: "When several machines print: Split screen / Alternate every N s".
  - Minimum display time (default 20 s, helper "Prevents flicker when a printer reconnects").
- **Health** tab: StructuredList — last heartbeat, published revision + time, player version, cache usage (ProgressBar "1.2 of 8 GB"), cameras (per camera: Live / Idle / Unavailable, "1680 × 1080 · H.264 · 30 fps"), recent errors list.
- **Settings** tab: name, location, orientation, resolution, visible-from-outside, default playlist. Save button.

**Announcements**: see the section *Announcements (v2)* below. The display header keeps a secondary **Show announcement** button that opens the same start dialog with this display preselected.

### Content `/signage/content`
Table toolbar with `SectionSwitcher` Scenes | Playlists (URL param `?section=`).
- **Scenes**: tile grid (Carbon `ClickableTile`) with a mini rendered thumbnail, name, orientation tag, "Used by 2 playlists · 1 rule". Primary **New scene** → modal: name, orientation, template picker (selectable tiles with schematic zone drawings).
- **Playlists**: DataTable: name, scenes count, loop length ("1 min 20 s"), used by displays. Primary **New playlist**.

### Scene editor `/signage/scenes/:sceneId`
Three columns on desktop (stack on narrow):
- **Left – Structure**: template (change via modal; zones keep widgets by position), list of zones (click to select), scene settings (background colour field like the material colour field, optional background image from Media with fit cover/contain and a 0–80 % darken/lighten veil for readability, theme dark/light text). The colour stays visible around a contained image.
- **Centre – Canvas**: scaled render of the scene in its aspect ratio; zones outlined, clicking a zone selects it, selected zone has a focus outline. Above the canvas: **Preview as** dropdown (Idle · H2D printing · Both printing · Camera unavailable · Live data stale) to see fallbacks.
- **Right – Zone properties**: widget type select (Empty, Image, Video, Slideshow, Text, QR code, Clock, Camera, Machine status, Open days, Events) and widget-specific fields:
  - Image/Video: media picker (from Media), fit contain/cover. Video: muted loop.
  - Slideshow: ordered media list, seconds per slide.
  - Text: text area, size S/M/L/XL, alignment.
  - QR code: URL + caption.
  - Clock: time / date+time.
  - Camera: source = Specific machine | Active machine (auto); several active → Split / Alternate; overlay progress + remaining time toggles; fallback when unavailable: Show image / Show status text / Hide zone. If any assigned display is visible from outside: warning "This display is visible from outside. Check the camera does not show people or documents."
  - Machine status: machines multi-select, show progress, show remaining time. Note "Only machine name, state and progress. Never customer names or prices."
  - Open days: next N dates. Events: next N events.
Header: scene name, "Saved · draft" status text, secondary **Preview fullscreen**. Autosave in the prototype; edits mark every display using this scene as having unpublished changes.

### Playlist detail `/signage/playlists/:playlistId`
Header name + "Loop 1 min 20 s". Ordered items (scene thumbnail, scene name, duration NumberInput s, transition Cut/Fade, up/down, remove). **Add scene** combo. Right: autoplaying preview frame cycling through the items.

### Media `/signage/media`
Header: storage meter "2.4 GB used". Primary **Upload** → `FileUploaderDropContainer` modal (images JPG/PNG/WebP up to 20 MB, videos MP4 up to 500 MB). A non-H.264 video shows "Converting for playback…" for a few seconds then "Ready".
Toolbar: search + type filter (Image / Video). Tile grid with thumbnail, name, "1080 × 1920 · 2.1 MB", "Used in 2 scenes". Click → side panel/modal with details: dimensions, size, format, checksum (short), uploaded by/at, used in (RefLinks to scenes). Delete is blocked when used by a published scene ("Remove it from Scene X and publish first").

### Local services `/settings/local-services`
One installation card "Makerspace Graz" (in the concept there is one installation per location). Services table: Printer connector (Online · v1.4.2 · credential rotates in 61 days), Streaming gateway (Online · v0.3.0 · 2 cameras). Overflow per service: Rotate, Revoke.
**Add service** → modal: choose Printer connector / Streaming gateway → shows one-time enrollment secret (`CodeSnippet`, "Valid for 15 minutes, shown once") + **Download compose bundle** button + `.env` snippet (`CORE_URL`, `STREAM_PUBLIC_HOST`). Cameras section: table machine, gateway, status (Live / Idle — no viewer / Unavailable), viewers, stream format. Camera access codes are configured on the machine's connection and are never shown here.

### Player `/signage/play/:displayId` (fullscreen, no shell)
Lightweight custom rendering (the real player is a separate small app, so **no Carbon components here**, plain CSS is intended). Fills the window, letterboxes to the display's aspect ratio. Renders the resolved scene; playlists rotate with fade. Camera zones show a mock live feed (a print preview image with a subtle animated noise/scan effect and a red "LIVE" badge), machine name, progress bar and "ends ~14:20". Split mode for two cameras. Live data stale (Core unreachable longer than TTL): machine status widgets show "Status unknown" instead of guessing; a small offline dot in a corner; cached media keep playing. Unpaired: big pairing code `K7F2QX`, "Enter this code in Makerspace Core › Signage › Pair display".

## Simulation controls
Extend the prototype controls panel with a **Signage simulation** group: H2D (Idle / Printing / Camera unavailable), X1C (same), Core reachable (toggle) and two shortcut buttons, "Start sample 'Closed' announcement" and "Stop all announcements". The live preview, editor preview and player react immediately.

## Resolution engine
Pure function `resolvePlayback(display, rules, sim, now, activeAnnouncements)` → `{ ruleId | 'default', target, reason, activeMachines }`; there is no announcement special case. Covered by vitest unit tests (time windows across weekdays, any/all machines, disabled rules, priority order, announcement rules match only by list position, template filter, stale data rule).

## Mock data
Displays: **Entrance window** (portrait 1080×1920, visible from outside, online, default playlist Ads, rule 1 "Any of H2D, X1C printing → Print live"); **Workshop info** (landscape 1920×1080, inside, online, default playlist Workshop info, rule "Mon–Fri 08:00–10:00 → Morning briefing"); **Laser room** (landscape, offline 2 h, 2 unpublished changes).
Scenes: Ad – Open days (portrait), Ad – Workshops, Ad – 3D printing service, Print live (portrait, header text + camera zone + machine status + QR footer), Workshop overview (landscape 2×2: machine status, open days, events, clock), Morning briefing, Closed today (announcement).
Media: 6–8 generated SVG data-URI posters (gradients + big text) and 2 mock videos (poster images). No network, no external files.

## Announcements (v2) — replaces the takeover

Agreed with the user: announcements are **content with variables**, shown wherever a scene contains an **Announcement** widget; displays decide via ordinary rules whether to switch to an announcement scene.

### Announcement templates (Content › Announcements, `signage.content.manage`)
Third section in the Content `SectionSwitcher`: Scenes | Playlists | **Announcements**.
A template has:
- **Name** (e.g. "Closed", "Back soon", "Machine out of order").
- **Fields** the person starting it fills in. Each field: label, key (auto from label, e.g. `reason`), type (Text · Long text · Time · Date · Date and time · Number · Choice with options · Machine), required, default value, optional helper text. Reorder up/down, add, remove.
- **Message**: title + body with placeholders `{reason}`. Insert via a "Insert variable" menu (custom fields + built-ins) so nobody has to type braces. Unknown placeholders are flagged inline.
- **Built-in variables**: `{ends_at}` (time, "14:30"), `{ends_on}` (date, "Mon 21 Oct"), `{ends}` (smart: "at 14:30" today, "on Mon 21 Oct at 10:00" otherwise, "until further notice" if open-ended), `{starts_at}`, `{today}`, `{display}` (display name), `{location}`.
- **Style**: tone Info (blue) · Warning (yellow) · Critical (red) · Neutral; optional icon/pictogram name. The widget renders with the tone.
- Live preview of the rendered message with sample values; editing the template shows "Used in N active announcements".
Seed templates: **Closed** (fields: reason Choice [Holiday, Event, Maintenance, Illness], back_on Date and time; message "Closed today – {reason}" / "We are back {ends}." with ends = back_on), **Back soon** (fields: minutes Number; "Back in {minutes} minutes"), **Machine out of order** (fields: machine Machine, note Long text; "{machine} is out of order" / "{note}").

**Deleting a template** (row overflow › Delete): blocked while anything uses it — active or scheduled announcements, display rules that filter on it, or Announcement zones that filter on it. The blocked dialog lists each use with a link. An unused template is deleted after confirmation, together with its ended announcements. Nothing is silently rewritten (a rule filter losing its only template would otherwise start matching every announcement).

### Starting / stopping (`signage.override`)
New page **Signage › Announcements** (`/signage/announcements`) — side nav item between Displays and Content. Shows **Active** (and scheduled) announcements as a list: rendered title, template, displays, "until 14:30", Stop / Edit. Primary **New announcement** → modal (ComposedModal, size md):
1. Template (tiles or select).
2. The template's fields, rendered as Carbon inputs by type (TextInput, TextArea, TimePicker/TextInput type=time, DatePicker, NumberInput, Select, machine Select). Required validation.
3. **Shown on**: All displays · Selected displays (MultiSelect).
4. **Start**: Now · At (date+time). **End**: Until I stop it · At (date + time) · After (duration: 15 min, 30 min, 1 h, 2 h, end of day). The end time feeds `{ends…}`.
5. Live preview of the rendered message (and a small frame preview of a target display's resolved scene).
Applies immediately (no publish), because announcements are live data, not layout. Several announcements may be active at once.

### Announcement widget (any scene)
New widget type **Announcement** in the zone properties: which announcements (All · Only templates …), style (Banner · Card · Full zone), text size, **when none is active**: Leave zone empty · Show fallback text · Show another widget (pick Image/Text/Clock/etc. via a nested simple widget select — prototype: fallback text or empty only is fine), **when several are active**: Rotate every N s · Show the newest · Stack. The widget renders the template's tone. In the editor's "Preview as", add "Announcement active" which uses the seeded Closed announcement.
So an ad scene can carry a slim announcement banner that only appears when something is active, with no rule needed.

### Rule condition "Announcement active"
The existing condition gets options: Any announcement · Only templates (multi-select). It matches if an active announcement targets this display (all or selected). Target is a normal scene/playlist — typically a scene built around a full-zone Announcement widget. **Remove the old implicit takeover** (announcement jumping to the top, the hidden default scene, the `quick text` shortcut). Order in the list is the only priority — what you see is what happens.
Seed: Entrance window rule 1 "Announcement active (Closed) → Scene Announcement full screen", rule 2 printers → Print live; Ad scenes on Entrance have a bottom Banner announcement zone where a template fits. Workshop info has none as a rule, but its overview scene has a banner zone.

### Simulation & engine
Simulation toggle "Announcement active" is replaced by the real Announcements page (seed: one scheduled "Closed" announcement, none active; the controls panel gets a shortcut "Start sample 'Closed' announcement" / "Stop all announcements").
Engine: `renderAnnouncement(template, values, timing, context) → { title, body, tone }` (pure, tested: built-ins, `{ends}` today/other day/open-ended, missing optional values render empty, unknown placeholders left visible) and `activeAnnouncementsFor(displayId, announcements, now)` (start/end windows, all vs selected displays). `resolvePlayback` uses that list for the condition, no special case.
Offline note in the spec/UI help: the player keeps active announcements it received and drops them at their end time even if Core is unreachable.


### Implementation notes (prototype)
- Announcements are live data in `SignageContext` (not part of a publication) and are mirrored to other tabs like the simulation, so the fullscreen player reacts.
- `{ends}`-style wording also applies to Date-and-time fields: "today at 14:30", "tomorrow at 10:00", "on Mon 21 Oct at 10:00". Seed "Closed" uses `{back_on}` (a Date and time field) in its body; `{ends}` comes from the End setting in the start dialog.
- Not built: template delete, icon/pictogram per template, "show another widget" as empty behaviour (fallback text or empty only).
- Scenes with an Announcement widget show the sample "Closed" announcement in thumbnails and in the editor's "Announcement active" preview.
