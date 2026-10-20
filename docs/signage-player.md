# Signage player: kiosk setup

The player is a small web app served by Makerspace Core at `https://<core>/player/`. A display is any device with a browser that opens this URL fullscreen: a Raspberry Pi 4/5, a mini PC or a TV stick running Chromium. The player has no login; it pairs once and then identifies itself with a device cookie.

## Requirements

- Chromium or Chrome 110 or newer (the player uses `AbortSignal.timeout`, container query units and `<video>` autoplay).
- A persistent browser profile. The device cookie lives in the profile; with a throw-away profile (`--incognito`, guest mode, a tmpfs `--user-data-dir`) the display has to be paired again after every restart.
- HTTPS to Core. The cookies are `Secure` (and `__Host-` prefixed) in production.
- Core must know the real client address: set `HTTP_TRUSTED_PROXIES` behind a reverse proxy, otherwise all displays share one rate limit (see `docs/signage.md`, "Security hardening").
- Optional: `SIGNAGE_PAIRING_ALLOWED_CIDRS` on Core restricts pairing to the makerspace network. Displays outside it show "This network may not pair displays".

## Pairing

See also [Signage](signage.md) for the content model and [Streaming gateway](streaming-gateway.md) for live printer cameras.

1. Start the browser on the display. It shows **This display is not paired** and a six-character code with a countdown (codes are valid for 15 minutes; a new one appears by itself).
2. In Makerspace Core open **Signage > Displays > Pair display**, enter the code and fill in name, location, orientation and resolution.
3. Within a few seconds the display reloads and plays. Until the first publication it shows "Waiting for content"; publish the display from its detail page.

Restarting the browser while a code is open is safe. If staff already claimed the code, the display says "Finishing set-up" and collects its credential.

Revoking a display in Core makes the player return to the pairing screen on its next request (within about 10 seconds).

## Chromium flags

```
chromium \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --hide-crash-restore-bubble \
  --autoplay-policy=no-user-gesture-required \
  --disable-features=Translate,TranslateUI \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  --check-for-update-interval=31536000 \
  --user-data-dir=/home/signage/.config/signage-chromium \
  https://core.example.org/player/
```

- `--kiosk` fullscreen without browser chrome; `--noerrdialogs`, `--disable-infobars`, `--disable-session-crashed-bubble` and `--hide-crash-restore-bubble` keep dialogs and "restore pages?" bubbles off the wall after a power cut.
- `--autoplay-policy=no-user-gesture-required` lets muted videos start without a click.
- On a Raspberry Pi add `--ozone-platform=wayland` (Wayland compositors such as labwc) or `--ozone-platform=x11`, and `--enable-features=VaapiVideoDecoder` only if hardware decoding is verified on that model.
- Hide the mouse pointer on X11 with `unclutter -idle 0.1 -root &` (the player already hides it inside the page).

## Autostart with systemd (user unit)

Create a user `signage` that logs in automatically to a minimal desktop session, then:

`~/.config/systemd/user/signage-player.service`

```ini
[Unit]
Description=Makerspace signage player
After=graphical-session.target
PartOf=graphical-session.target

[Service]
# Wayland: remove DISPLAY and set WAYLAND_DISPLAY / XDG_RUNTIME_DIR for your compositor instead.
Environment=DISPLAY=:0
ExecStartPre=/usr/bin/xset s off
ExecStartPre=/usr/bin/xset -dpms
ExecStartPre=/usr/bin/xset s noblank
ExecStart=/usr/bin/chromium --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --hide-crash-restore-bubble --autoplay-policy=no-user-gesture-required --overscroll-history-navigation=0 --user-data-dir=%h/.config/signage-chromium https://core.example.org/player/
Restart=always
RestartSec=5
# Restart a hung browser: kill it if it ignores SIGTERM for 20 seconds.
TimeoutStopSec=20

[Install]
WantedBy=graphical-session.target
```

Enable it once and let the user session start without a keyboard login:

```
systemctl --user daemon-reload
systemctl --user enable --now signage-player.service
loginctl enable-linger signage
```

`Restart=always` restarts Chromium after a crash or when someone closes it. For a display that runs for months, add a nightly restart (a `signage-player-restart.timer` that runs `systemctl --user restart signage-player.service` at 04:00) to release browser memory.

## Screen blanking and power saving

- X11: the `xset` lines above turn off the screensaver and DPMS. Also remove `xscreensaver`/`light-locker` from the session.
- Wayland (Raspberry Pi OS with labwc): do not start an idle or lock daemon (`swayidle`, `swaylock`) and turn off the screen-blanking option of the Raspberry Pi configuration tool. Switch off console blanking with `consoleblank=0` in `/boot/firmware/cmdline.txt`.
- Disable Wi-Fi power saving (`iw dev wlan0 set power_save off`) on wireless displays; prefer Ethernet.
- Set the TV to "always on" and disable auto power-off, energy saving and "no signal" standby.

## What the player does

- Polls live data every 10 s, sends a heartbeat every 30 s (Core shows a display as online while heartbeats are younger than 90 s).
- Applies a new publication only after all its images and videos are loaded, then switches at once. A video that does not buffer within 30 s is accepted and reported in the next heartbeat.
- Keeps playing the last revision when Core is unreachable and shows a small yellow dot in the bottom-right corner. Time-window rules keep working offline. After 60 s without live data machine widgets show "Status unknown" and the `live data unavailable` rule applies. See "Offline operation" below.
- Letterboxes to the configured resolution and orientation; it does not rotate the output. Rotate the screen in the operating system (`wlr-randr --output HDMI-A-1 --transform 90`, `xrandr --output HDMI-1 --rotate left`) and set the display to portrait in Core.
- Camera widgets show their configured fallback until the streaming gateway exists.

## Offline operation

The player installs a service worker the first time it loads over HTTPS (or from `localhost`) and then works without network:

- **Cold start offline.** The player shell is cached by the service worker and the last activated revision, with all its images and videos, is stored in the browser profile. After a power cut with the network still down the display starts and plays that revision (small yellow dot), including time-window rules. It never shows the pairing screen because of a network error; only Core answering "not authorized" does that.
- **New publications** are downloaded completely first. The display switches only when every file is stored, so a flaky connection never leaves it with half a revision. Files the new revision no longer uses are deleted afterwards.
- **Storage.** The player asks Chromium for persistent storage and reports used and available bytes in the heartbeat (display detail page in Core). If a revision does not fit, it is not activated, the old content keeps playing and the error shows in the display's health. Free disk space on the device or remove large unused media from the publication.
- **After a restart while offline** the announcements, open days and events of the last successful poll are shown again (announcements until their end time; ones younger than 24 h). Machine status is never shown from storage: widgets say "Status unknown" until a poll succeeds.
- Requirements: a secure origin (HTTPS) and a persistent browser profile (`--user-data-dir`, not incognito). Without a service worker the player still works online but cannot start offline.
- **Updates.** The browser checks `/player/sw.js` every 6 hours; a new player build reloads the page once.

### Clearing the cache on a kiosk

Normally not needed: revoking the display in Core makes the player delete its cache. To reset a kiosk by hand (corrupt profile, moving the display to another Core):

1. Stop the browser: `systemctl --user stop signage-player.service`.
2. Delete the profile directory used with `--user-data-dir` (for example `rm -rf ~/.config/signage-chromium`). This also removes the device cookie, so the display has to be paired again.
3. Start it again: `systemctl --user start signage-player.service`.

To keep the pairing and drop only the cached content, open `chrome://serviceworker-internals`, unregister `/player/`, then in DevTools (Application, Storage) clear "Cache storage" for the Core origin, and reload.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Pairing screen after every restart | The browser profile is not persistent (incognito, tmpfs profile, profile deleted at boot). Use a fixed `--user-data-dir`. |
| "This network may not pair displays" | Core restricts pairing with `SIGNAGE_PAIRING_ALLOWED_CIDRS`. Pair from the makerspace network; after pairing the display can run anywhere. |
| "Too many requests, trying again shortly" | Core limits 10 pairing codes per hour per client address. Behind a proxy make sure `HTTP_TRUSTED_PROXIES` is set. Wait; the player retries by itself. |
| "Cannot reach Makerspace Core" | DNS, certificate (the clock of the device must be right) or firewall. Open the URL in a normal browser to see certificate errors. |
| "Waiting for content" | The display is paired but was never published. Publish it from the display detail page. |
| Black screen, yellow dot | The first load failed and nothing is cached yet (a new display needs one online start); the player retries with growing delays (up to 2 minutes). Check the network. |
| Revision not activated, "Not enough storage" in health | The device's browser storage is too small for the new media. Free space or reduce media; the old revision keeps playing. |
| Old content after a publication | The new revision is still loading (large videos) or an asset failed. The display detail page shows the revision the display reports; errors appear in the health tab. |
| Video stutters or stays black | Use H.264 MP4 at the display resolution or lower; on a Raspberry Pi 4 keep to 1080p30. |
| Display is "offline" in Core but shows content | Heartbeats fail (rate limit, proxy blocking POST). Check the proxy log for `/api/v1/signage/player/heartbeat`. |
| Needs to be paired again | Revoke the old display in Core (or delete it) and clear the browser profile, or just wait for the pairing screen after revoking. |

Developer note: `https://<core>/player/` works with any current browser, so a staff member can check a display setup on a laptop. A paired browser keeps its device cookie, so use a separate profile for tests.
