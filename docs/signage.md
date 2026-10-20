# Digital signage

Centrally managed information and advertising screens for one makerspace. Displays run a small, separate player web app in a Chromium kiosk. Content, rules and devices are managed in Core; printer camera video stays inside the makerspace LAN and flows through a local streaming gateway.

The approved UI prototype lives in `frontend/src/prototype/machines-jobs/signage/` (spec: its `DESIGN.md`). The real admin UI follows that prototype screen by screen. This document is the implementation contract.

## Concepts

| Concept | Meaning |
|---|---|
| Display | One physical screen. Bound 1:1 to a managed device whose only application mode is `signage_player`. |
| Scene | One screen composition: a zone **layout template** (fixed set, defined in code) plus one widget per zone, background colour/image, text theme. |
| Playlist | Ordered scenes with seconds per item and a transition (`cut`, `fade`). |
| Rule | Per display, ordered. "When *condition* show *scene or playlist*". First enabled match wins; the display's default playlist is the fallback. |
| Publication | Immutable manifest per display: rules, default playlist and every scene, playlist and asset they reach, at publish time. Players only ever play publications. |
| Asset | An uploaded image or video (metadata here, bytes in the existing files/storage module). |
| Announcement template | Fields (typed inputs) + title/body with `{placeholders}` + tone. |
| Announcement | A started instance of a template: values, target displays (all or selected), start, optional end. Live data, never published. |
| Streaming gateway | Headless local service (Go) that registers with Core, controls a bundled go2rtc, and serves camera streams to players on the LAN with ticket checks. |

## Permissions (registered; never role names)

| Permission | Allows |
|---|---|
| `signage.read` | Read displays, health, content, media, rules, announcements |
| `signage.manage` | Pair, rename, revoke, delete displays; edit rules, default playlist, display settings |
| `signage.content.manage` | Create/edit/delete scenes, playlists, assets, announcement templates |
| `signage.publish` | Publish a display |
| `signage.override` | Start, edit, stop announcements |
| `local_services.manage` | Manage streaming gateways and camera assignments; issue enrollment secrets |

Every write permission implies nothing else; services check exactly what they need and the frontend hides controls accordingly (UX only).

## Data model (migration `00051_signage.sql`, later `00052_streaming_gateways.sql`)

UUIDv7 ids generated in Go, `timestamptz` UTC, `version int` for optimistic concurrency on editable rows (`expectedVersion` on writes, 409 `stale_write`). JSONB only for the scene zone tree and publication manifests.

- `signage_displays`: id, managed_device_id (unique, FK managed_devices ON DELETE RESTRICT), name, location, orientation (`portrait`|`landscape`), resolution_width/height, visible_from_outside bool, default_playlist_id (FK, RESTRICT), revoked_at, created_at, updated_at, version.
- `signage_pairing_requests`: id, code_digest (unique among open requests), poll_secret_digest, created_at, expires_at (15 min), claimed_display_id (nullable FK), claimed_at, delivered_at. Rows are deleted after delivery or expiry (cleanup on access + periodic sweep is not needed; delete expired rows opportunistically in the same statements).
- `signage_assets`: id, file_id (FK files, RESTRICT), kind (`image`|`video`), name, width, height, duration_ms (nullable), created_by_account_id, created_at.
- `signage_scenes`: id, name, orientation, layout_id (text, validated against the code-defined layouts), background_color (`#rrggbb`), background_asset_id (nullable FK RESTRICT), background_fit (`cover`|`contain`), background_dim (0–80), theme (`dark`|`light`), zones jsonb, created_at, updated_at, version.
- `signage_playlists`: id, name, created_at, updated_at, version. `signage_playlist_items`: playlist_id, position, scene_id (FK RESTRICT), seconds (3–3600), transition. PK (playlist_id, position).
- `signage_rules`: id, display_id (FK CASCADE), position, enabled, condition_kind (`time_window`|`machine_printing`|`announcement_active`|`live_data_unavailable`), weekdays smallint[] (ISO 1–7), time_from/time_to (time, may wrap midnight), machine_ids uuid[], machine_match (`any`|`all`), announcement_template_ids uuid[] (empty = any), target_kind (`scene`|`playlist`), target_scene_id / target_playlist_id (exactly one, FK RESTRICT), min_seconds (0–600, default 20), multi_mode (`split`|`alternate`), alternate_seconds. CHECK constraints per kind. Unique (display_id, position) DEFERRABLE.
- `signage_publications`: id, display_id (FK CASCADE), revision (per display, starting 1), manifest jsonb, manifest_sha256, published_by_account_id, published_at. Unique (display_id, revision). Keep the latest 5 per display.
- `signage_display_states` (ephemeral, not audited): display_id PK, last_heartbeat_at, publication_revision, current_rule (text: rule id, `default`), current_scene_id, player_version, cache_used_bytes, cache_quota_bytes, errors jsonb (max 20 short entries, no PII).
- `signage_announcement_templates`: id, name, tone (`info`|`warning`|`critical`|`neutral`), title, body, created_at, updated_at, version. `signage_announcement_template_fields`: template_id, position, key (`^[a-z][a-z0-9_]{0,39}$`, not a built-in), label, type (`text`|`longtext`|`time`|`date`|`datetime`|`number`|`choice`|`machine`), required, default_value, helper_text, options text[] (choice only).
- `signage_announcements`: id, template_id (FK RESTRICT), all_displays bool, starts_at, ends_at (nullable), created_by_account_id, created_at, updated_at, version. `signage_announcement_values`: announcement_id, key, value (text ≤ 2000). `signage_announcement_displays`: announcement_id, display_id. Ended announcements are hard-deleted after 30 days (on access) — no indefinite retention of message content.
- Gateway phase: `streaming_gateways` (id, name, lifecycle, credential tables mirroring printer connectors), `streaming_gateway_enrollments`, `streaming_cameras` (id, gateway_id, machine_id unique, enabled, created_at, version). Camera RTSPS host/access code are **not** duplicated: they come from the machine's active printer-connector assignment settings and encrypted secrets (`ipAddress`, `lanAccessCode`) at configuration time.

Every mutation writes its audit event in the same transaction (`audit.Write`, changed field names only; never announcement values or token material). Pairing, heartbeats and live reads are not audited, except pairing claim and device revoke.

## Scene zones (JSONB, validated in Go)

`zones` is an object `{ "<zoneId>": Widget }`; zone ids must belong to the layout. Unknown keys are rejected (strict decoding), text lengths are capped, no HTML (plain text only, rendered as text nodes), URLs for QR codes must be `https://`. Widget types and fields mirror the prototype `types.ts` (`empty`, `image`, `video`, `slideshow`, `text`, `qr`, `clock`, `camera`, `status`, `open_days`, `events`, `announcement`). Layouts are a fixed, versioned list shared by backend validation (zone ids) and frontend rendering (grid CSS), defined once in `api/openapi.yaml` as an enum and in `frontend/src/features/signage/layouts.ts`.

## Publish and drafts

Scenes, playlists, rules, default playlist and display settings are drafts. `POST /signage/displays/{id}/publish` (signage.publish) builds the manifest from current drafts in one transaction, stores the publication and audits it. `GET /signage/displays/{id}` returns `publishedRevision`, `publishedAt` and `pendingChanges: [{kind, name, change}]`, computed by comparing the draft manifest with the latest publication (by entity id + version). Deleting a scene/playlist/asset referenced by drafts is a 409 listing references; anything only referenced by older publications may be deleted (players keep their cached copy until they get a new manifest).

## Player protocol

The player is unauthenticated until paired, then authenticates as its managed device (HttpOnly cookie, the existing managed-device cookie). A `signage_player` device may only call `/signage/player/*` (and the public pairing endpoints); it can never hold a staff session. All player responses are `Cache-Control: no-store` except content-addressed asset bytes.

1. **Pairing.** `POST /public/signage/pairing` → creates a request with a 6-character code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (CSPRNG) and a 32-byte poll secret set as HttpOnly `SameSite=Strict` cookie; returns `{code, expiresAt}`. Rate-limited per client IP (e.g. 10/hour) and globally capped (e.g. 50 open requests). `GET /public/signage/pairing` (poll every 3 s, with that cookie) → `pending` | `expired` | `paired`. On the first `paired` poll the server creates the device token, sets the managed-device cookie, marks the request delivered and deletes it — the plaintext token never sits in the DB.
   Staff: `POST /signage/displays` `{code, name, location, orientation, resolution, visibleFromOutside, defaultPlaylistId}` (signage.manage) finds the open request by code digest, creates managed device (mode `signage_player`, no staff, no terminal), display and an empty first publication-ready state; unknown/expired code → 422 `pairing_code_invalid` (same message for both). Failed attempts are rate-limited per account.
2. **Manifest.** `GET /signage/player/manifest?known=<revision>` → 304-like `{unchanged: true}` or the full manifest `{revision, display: {orientation, resolution, visibleFromOutside}, rules, defaultPlaylistId, scenes, playlists, assets: [{id, kind, sha256, size, url}], layouts version}`. Assets: `GET /signage/player/assets/{assetId}/{sha256}` → bytes, `Cache-Control: private, max-age=31536000, immutable`, only if the asset is in the display's latest publication.
3. **Live.** `GET /signage/player/live` every ~10 s → `{serverTime, revision, machines: [{machineId, name, state, progressPercent, remainingMinutes, observedAt, stale}], announcements: [{id, templateId, tone, title, body, startsAt, endsAt}], openDays: [...next 5 public], events: [...next 5 public-safe: title, startsAt, location], streams: [{machineId, url, ticket, expiresAt}] }`. Machines are those referenced by the display's published rules/widgets; state comes from `printer_live_statuses`, stale when `received_at` is older than 3 minutes (state `unknown`). Announcements are rendered server-side (Go is authoritative; built-ins `{ends_at} {ends_on} {ends} {starts_at} {today} {display} {location}`; times in the makerspace time zone from config). No customer data, ever.
4. **Heartbeat.** `POST /signage/player/heartbeat` `{revision, currentRule, currentSceneId, playerVersion, cacheUsedBytes, cacheQuotaBytes, errors[]}` every 30 s → upserts `signage_display_states`. Display status: online if heartbeat < 90 s, otherwise offline.

The player evaluates rules locally (TypeScript engine shared with the admin preview: `frontend/src/features/signage/engine/`), so time windows keep working offline. `live_data_unavailable` matches when the last successful live poll is older than 60 s. Min display time is enforced by the player (a winning rule keeps the screen for at least `min_seconds` unless a higher-priority rule takes over). Announcement rendering also has a TypeScript copy for the admin live preview; both implementations run the same JSON test vectors (`api/testdata/signage-announcement-render.json`).

## Player app

Separate Vite entry `frontend/player.html` → `src/player/main.tsx`; no Carbon, no TanStack Query, no app shell; plain CSS. It must not import from `src/app` or Carbon packages (lint rule or test). Its own bundle budget: ≤ 90 kB gzip JS. Served by the same nginx at `/player/` with `Cache-Control: no-cache` for HTML.

- Screens: pairing code (big code, expiry countdown, regenerates on expiry), playing, fatal error.
- Offline (phase 4): a service worker caches the manifest, the player shell and all published assets (Cache Storage, keyed by sha256); a new revision activates only after every asset is cached; old assets are evicted after activation; quota is reported in heartbeats. Live data has TTLs: machine status shows "Status unknown" after 60 s without a successful poll; announcements are kept until their `endsAt` (open-ended ones are kept until the next successful poll).
- Implemented in `frontend/src/player/`: `api.ts` (five-call fetch wrapper), `pairing.ts` (pairing loop), `runtime.ts` (revision activation after preload, live/heartbeat/manifest loops, backoff, revocation), `view.ts` (shared engine plus the `min_seconds` hold), `camera.ts` (`CameraSource` seam for phase 5: `hasStream` marks cameras without a stream unavailable, `view` supplies the picture through `RenderData.cameraView`). The import graph is enforced by an ESLint override and `src/player/imports.test.ts`; the budget (JS 90 kB, CSS 20 kB gzip) is checked per entry in `scripts/check-bundle-budget.mjs`. A 404 other than `signage_not_published` on a player endpoint is treated like a revoked credential.
- Kiosk: documented Chromium flags and a systemd unit example in `docs/signage-player.md` (autostart, watchdog restart, screen blanking off).

## Streaming gateway and cameras (phase 5)

- **Core side** (`backend/internal/streaminggateways`): gateway registry with lifecycle, one-time enrollment secret (15 min, digest stored), runtime credentials and rotation — reuse the printer-connector pattern and code paths where sensible. `GET /streaming-gateway/configuration` (gateway auth) returns revision, `ticketPublicKey`, and cameras `[{machineId, name, rtspsUrl}]` where the URL is built from the machine's active printer assignment (`rtsps://bblp:<lanAccessCode>@<ip>:322/streaming/live/1`), decrypted with the existing keyring. Only `local_services.manage` can create/revoke gateways and cameras; credentials are never shown again after issue. Heartbeat with per-camera health (`live`|`idle`|`unavailable`, viewers, codec/resolution).
- **Tickets**: Core signs short-lived (5 min) stream tickets with Ed25519 (`{displayId, machineId, exp}`), handed out in `/signage/player/live` only for cameras the display's publication uses. The gateway verifies them offline with the public key from its configuration. Revoking a display stops new tickets; existing ones expire within 5 minutes.
- **Gateway binary** (`backend/cmd/streaming-gateway`, `backend/internal/streaminggateway`): enrolls, polls configuration every 30 s, writes go2rtc's config (streams only, API bound to the internal Docker network, no UI exposed), restarts/reloads go2rtc on change, and runs an HTTPS reverse proxy on `STREAM_PUBLIC_HOST` that only exposes go2rtc's WebRTC (`/api/webrtc`) and MSE websocket (`/api/ws`) for allowed `src` values with a valid ticket. TLS cert/key from mounted files. Idle streams are stopped by go2rtc after the last viewer (go2rtc default behaviour, verify).
- **Bundle**: `local-services/compose.yaml` with `printer-connector`, `streaming-gateway` and `go2rtc` (pinned image digest), shared internal network, only the gateway's 443 published; `.env` with `CORE_URL`, `STREAM_PUBLIC_HOST`; enrollment secrets as files. The existing standalone printer-connector compose keeps working.
- **Player camera widget**: WebRTC first, MSE fallback, using the gateway URL + ticket from live data; falls back per widget setting (image / status text / hide) when unavailable. Outside-visible displays show the confirmation note in the editor (UX) — backend does not block it.

## Admin UI (real app)

`frontend/src/features/signage/`, routes lazy-loaded, nav group "Signage" (Displays, Announcements, Content, Media) and "Local services" under the existing settings area. Screens and behaviour follow the prototype spec; Carbon components only; React Hook Form for the pair, rule, template and announcement forms; TanStack Query for server state. The scene renderer is shared between admin previews and the player (`src/features/signage/render/`, plain CSS, no Carbon) so previews are pixel-equivalent.

## Testing

- Go unit tests: zone validation, rule validation, announcement rendering (vectors), ticket signing/verification, pairing code generation.
- PostgreSQL integration tests (`backend/tests/integration/signage_*_test.go`): every permission (allowed and denied), pairing flow end to end incl. expiry and wrong code, device mode isolation (signage device cannot call staff APIs; staff cannot call player APIs without a device), publish manifest contents, reference-blocked deletes, announcement targeting/time windows, asset access limited to published assets, audit rows in the same transaction.
- Frontend: engine unit tests (ported from the prototype), page tests for permission gating, player tests for rule evaluation and revision activation.

## Phase 1b decisions

- **Rule concurrency.** Rules have no version of their own: every rule write (create, update, enable toggle, delete, reorder) quotes the display's `expectedVersion` and bumps it. Responses return the full ordered rule list plus the new `displayVersion`. Reorder is `PUT /signage/displays/{id}/rule-order` with the complete id list. New rules are appended; deleting closes position gaps.
- **Pairing details.** The device is created at claim time with an unusable random token digest; the first `paired` poll replaces it with the real token digest (`SetManagedDeviceTokenDigest`) and deletes the request. A claimed request stays collectable for 5 minutes. Poll-secret cookie: `makerspace_signage_pairing` (`__Host-` prefix in production), `Path=/`. Per-IP limit 10 codes/hour, 50 open requests, 10 wrong codes per account per 15 minutes (in-memory, single instance).
- **Managed device type.** Paired devices use a device type named "Signage display", created on demand. Generic managed-device endpoints reject `signage_player` (422) and refuse to edit or rotate signage devices.
- **Manifest response.** `GET /signage/player/manifest` answers `{unchanged, manifest?}` instead of a bare manifest; before the first publication it answers 404 `signage_not_published`. Only enabled rules are published. Pending changes are empty for a display that was never published.
- **Revoked displays.** Revoking a display (or its managed device through the generic endpoint) makes the credential invalid (401); a device without a display answers 404.
- **Assets.** Served with HTTP Range support when the storage reader is seekable (local storage); S3 storage streams the full body with `Accept-Ranges: none`.
- **Live.** Open days and events come from the public calendar only (`events.ListUpcomingPublic`: published, planned or confirmed events with a public title, next public session, title/start/location only).

## Media and picker API details

- **Image caps.** PNG, JPEG and WebP up to 20 MiB; at most 8192 px per side and 40 megapixels (422 otherwise). Dimensions come from the decoded header, never from the client.
- **Video.** MP4 only, up to 200 MiB; width, height and duration are optional client-measured headers.
- **File names.** `X-File-Name` carries the percent-encoded UTF-8 name (`encodeURIComponent`). The server decodes it with `url.PathUnescape` and answers 400 `invalid_request` for invalid encodings, invalid UTF-8, control characters or a decoded name over 600 bytes; the stored name is limited to 150 characters (422). Plain ASCII names keep working.
- **Uploader.** Asset responses include `createdByName` (the uploader's person name; `null` once the account is deleted).
- **Content caching.** `GET /signage/assets/{id}/content?v=<sha256>` answers `Cache-Control: private, max-age=31536000, immutable` when `v` equals the asset's `sha256`, and `private, no-store` otherwise. Admin thumbnails and previews always use the `?v=` URL.
- **`GET /signage/machines`.** Picker data for widgets and rules: `{items: [{id, name, kind, hasCamera}]}` ordered by name, `kind` being the machine type. Allowed with `signage.read`, `signage.manage` or `signage.content.manage`; `machines.read` is not needed. `hasCamera` is `false` until the streaming-gateway phase assigns cameras.
- **Time zone.** `GET /public/config` includes `timeZone`, the makerspace IANA zone the server renders announcements in; the admin announcement preview uses it instead of the browser zone.

## Security hardening (review follow-up)

- **Pairing rate limits** (in-memory, single instance): 10 codes/hour and 60 polls/minute per client IP (IPv4 by address, IPv6 by /64), 50 open requests, 10 wrong codes per staff account per 15 minutes. The wrong-code counter reserves an attempt before checking the code and refunds it on success, so parallel guesses cannot exceed the limit. Each limiter tracks at most 4096 keys; when full and nothing has expired, new keys are refused (fail closed).
- **`HTTP_TRUSTED_PROXIES` must be set behind a reverse proxy** (the bundled nginx included). Without it every client appears as the proxy's address and the per-IP limits throttle all displays together.
- **`SIGNAGE_PAIRING_ALLOWED_CIDRS`** (optional, comma-separated CIDRs): when set, `POST /public/signage/pairing` is answered 403 `pairing_network_denied` unless the client IP (after trusted-proxy resolution) is inside one of the networks. Use it to limit pairing to the makerspace LAN. Polling is unaffected.
- **Restarting pairing** never deletes a request staff already claimed; it answers 409 `pairing_claimed` and the player collects its credential with the cookie that started the request (5-minute window).
- **Player rate limits**: 120 requests/minute per device on `/signage/player/*`, 600/minute for asset downloads. `managed_devices.last_seen_at` is written at most every 5 minutes (SQL guard in `TouchManagedDevice`).
- **Uploads**: raw binary upload routes (signage assets, event files, profile images, branding assets, Laborordnung PDFs, connector artifacts) skip OpenAPI request-body validation (headers are still validated), so unauthenticated bodies are never read; size caps remain. Images are limited to 8192 px per side and 40 megapixels. Asset bytes, file row, asset row and both audit events commit in one transaction.
- **Publishing** answers 409 `stale_write` when a concurrent change to the display aborts the snapshot transaction.
- **Announcement retention**: ended announcements are hard-deleted after 30 days, swept from admin reads and (at most every 10 minutes per process) from player live requests.
