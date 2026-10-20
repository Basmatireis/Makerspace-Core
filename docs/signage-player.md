# Signage player: kiosk setup

The player is a small web app served by Makerspace Core at `https://<core>/player/`. A display is any device with a browser that opens this URL fullscreen: a Raspberry Pi 4/5, a mini PC or a TV stick running Chromium. The player has no login; it pairs once and then identifies itself with a device cookie.

## Requirements

- Chromium or Chrome 110 or newer (the player uses `AbortSignal.timeout`, container query units and `<video>` autoplay).
- A persistent browser profile. The device cookie lives in the profile; with a throw-away profile (`--incognito`, guest mode, a tmpfs `--user-data-dir`) the display has to be paired again after every restart.
- HTTPS to Core. The cookies are `Secure` (and `__Host-` prefixed) in production.
- Core must know the real client address: set `HTTP_TRUSTED_PROXIES` behind a reverse proxy, otherwise all displays share one rate limit (see `docs/signage.md`, "Security hardening").
- Optional: `SIGNAGE_PAIRING_ALLOWED_CIDRS` on Core restricts pairing to the makerspace network. Displays outside it show "This network may not pair displays".

## Pairing

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
- Keeps playing the last revision when Core is unreachable and shows a small yellow dot in the bottom-right corner. Time-window rules keep working offline. After 60 s without live data machine widgets show "Status unknown" and the `live data unavailable` rule applies.
- Letterboxes to the configured resolution and orientation; it does not rotate the output. Rotate the screen in the operating system (`wlr-randr --output HDMI-A-1 --transform 90`, `xrandr --output HDMI-1 --rotate left`) and set the display to portrait in Core.
- Camera widgets show their configured fallback until the streaming gateway exists.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Pairing screen after every restart | The browser profile is not persistent (incognito, tmpfs profile, profile deleted at boot). Use a fixed `--user-data-dir`. |
| "This network may not pair displays" | Core restricts pairing with `SIGNAGE_PAIRING_ALLOWED_CIDRS`. Pair from the makerspace network; after pairing the display can run anywhere. |
| "Too many requests, trying again shortly" | Core limits 10 pairing codes per hour per client address. Behind a proxy make sure `HTTP_TRUSTED_PROXIES` is set. Wait; the player retries by itself. |
| "Cannot reach Makerspace Core" | DNS, certificate (the clock of the device must be right) or firewall. Open the URL in a normal browser to see certificate errors. |
| "Waiting for content" | The display is paired but was never published. Publish it from the display detail page. |
| Black screen, yellow dot | The first load failed; the player retries with growing delays (up to 2 minutes). Check the network. |
| Old content after a publication | The new revision is still loading (large videos) or an asset failed. The display detail page shows the revision the display reports; errors appear in the health tab. |
| Video stutters or stays black | Use H.264 MP4 at the display resolution or lower; on a Raspberry Pi 4 keep to 1080p30. |
| Display is "offline" in Core but shows content | Heartbeats fail (rate limit, proxy blocking POST). Check the proxy log for `/api/v1/signage/player/heartbeat`. |
| Needs to be paired again | Revoke the old display in Core (or delete it) and clear the browser profile, or just wait for the pairing screen after revoking. |

Developer note: `https://<core>/player/` works with any current browser, so a staff member can check a display setup on a laptop. A paired browser keeps its device cookie, so use a separate profile for tests.
