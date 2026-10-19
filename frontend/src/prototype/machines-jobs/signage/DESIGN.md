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
| `signage.override` | Start/stop an announcement takeover |
| `local_services.manage` | Local services: enrollment secrets, compose bundle, revoke services |

Role presets: supervisor gets all. New preset **Content editor** (`signage.read`, `signage.content.manage`): can edit scenes/playlists/media, cannot pair, publish or change rules. Front desk additionally gets `signage.read` + `signage.override` (can put up a "Closed today" announcement). Controls without permission are hidden, never just disabled-without-reason.

## Navigation

New side-nav heading **Signage**: Displays (`/signage`), Content (`/signage/content`), Media (`/signage/media`).
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

**Announcement takeover** (`signage.override`): a secondary button "Show announcement" in the header area opens a modal: pick an announcement scene or type a quick text, until (time / "until I stop it"). While active a warning banner with **Stop announcement**. Takeover applies immediately (no publish needed) — it is the one live override.

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
Extend the prototype controls panel with a **Signage simulation** group: H2D (Idle / Printing / Camera unavailable), X1C (same), Core reachable (toggle), Announcement active (toggle). The live preview, editor preview and player react immediately.

## Resolution engine
Pure function `resolvePlayback(display, rules, sim, now)` → `{ ruleId | 'default', target, reason, activeMachines }`. Covered by vitest unit tests (time windows across weekdays, any/all machines, disabled rules, priority order, announcement beats everything above it only by order, stale data rule).

## Mock data
Displays: **Entrance window** (portrait 1080×1920, visible from outside, online, default playlist Ads, rule 1 "Any of H2D, X1C printing → Print live"); **Workshop info** (landscape 1920×1080, inside, online, default playlist Workshop info, rule "Mon–Fri 08:00–10:00 → Morning briefing"); **Laser room** (landscape, offline 2 h, 2 unpublished changes).
Scenes: Ad – Open days (portrait), Ad – Workshops, Ad – 3D printing service, Print live (portrait, header text + camera zone + machine status + QR footer), Workshop overview (landscape 2×2: machine status, open days, events, clock), Morning briefing, Closed today (announcement).
Media: 6–8 generated SVG data-URI posters (gradients + big text) and 2 mock videos (poster images). No network, no external files.
