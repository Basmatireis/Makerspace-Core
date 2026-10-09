# Android terminal

`android-terminal/` is a native Android WebView shell around the existing Core frontend. It owns device registration, NFC Reader Mode, secure credential storage, restricted navigation, offline/retry presentation, fullscreen behavior, and optional managed Lock Task mode. Business rules, attendance decisions, permissions, and session expiry remain in the Go API and shared web application.

## Build and test

The reproducible repository check uses JDK 17, Android SDK 36, Android Build Tools 36, Gradle 9.6, and Android Gradle Plugin 9.4:

```sh
make test-android
```

That command builds a pinned `linux/amd64` container because the official Linux AAPT2 tool is x86_64, runs `testDebugUnitTest`, and assembles debug and unsigned release APKs. Docker Desktop or OrbStack performs this build-container emulation on Apple Silicon; the resulting APKs remain usable on ARM64 Android. For Android Studio, open `android-terminal/`, select JDK 17, install SDK 36, and run the `app` configuration.

On Apple Silicon, create an Android Virtual Device with an ARM64 system image for API 36. Start Core on the host and use `http://10.0.2.2:8080` in a debug build. The debug network policy permits cleartext only for `10.0.2.2`, `localhost`, and `127.0.0.1`; release builds require HTTPS. The emulator has no NFC controller, so use the debug-only NFC simulator button to exercise scan, duplicate, removal, disconnect, reconnect, and unsupported-reader states.

For a local emulator run:

1. Start the Core development stack and apply current migrations.
2. In Core, create a terminal Session Policy and a Managed Device with `visitor_terminal`, optionally `staff_ui`, and configured `nfc` capability. Copy its one-time native token.
3. Launch the debug app, keep the default `http://10.0.2.2:8080` URL, and register with that token.
4. Use the simulator button and confirm that Core shows the reader state without turning the scan into a login.
5. Sign in through Staff UI, wait for a deliberately short test policy, and verify that the next protected request is rejected and the web app returns to the configured destination.
6. Remove `staff_ui` in Core and verify that staff login is rejected; restore it for a dual-mode device.
7. Reload and restart the app to verify encrypted registration recovery. Stop Core to display the retry banner, restart it, and tap the banner.

## Registration and startup

Create a native-token Managed Device in Core and enter its Core URL and show-once token in the Android setup dialog. The app validates the token through `PUT /api/v1/managed-devices/self/hardware`. Server-returned application modes and terminal state determine the initial route:

- a terminal-enabled device with `visitor_terminal` opens `/terminal`;
- other permitted devices open `/login`.

The token is encrypted with an Android Keystore AES-GCM key. JavaScript cannot read it. The native client sends it only in `X-Managed-Device-Token` for capability registration and does not manufacture a browser `Origin` header. Core permits an originless native request only for this exact endpoint when the native credential header is present; the authentication middleware still validates the token, and foreign browser origins remain rejected. The app installs an HttpOnly, SameSite cookie for Core WebView requests.

There is no separate native token exchange. The first hardware report authenticates the issued token and returns the registered device identity; only then does the app durably store the encrypted credential and identity. On startup it revalidates them. A `401` means the token is invalid, expired, or revoked and requires token rotation. A `403` with `origin_invalid` means the Core server predates native originless hardware reporting and must be updated; allowed modes and hardware capabilities do not cause that response. Other policy and network failures keep an existing registration and show a retryable error instead of discarding a valid credential.

## Web bridge and NFC

The native bridge uses `WebViewCompat.addWebMessageListener` with the exact configured Core origin. It accepts messages only from the main frame and exposes one narrow method, `getDeviceInfo`. Native events travel through the same versioned event model as the desktop bridge. File/content access, mixed content, cross-origin navigation, and proceed-on-TLS-error are disabled.

Android Reader Mode emits normalized tag IDs plus technical protocol metadata. A scan is only a hardware event. It does not sign in a person, check a visitor in, or bypass the existing Lab Rules and supervisor decisions. Those actions continue through existing server endpoints and permissions.

The app queues at most 32 events during a page reload and then resumes delivery. Session idle and absolute expiry are still enforced by the server; WebView lifecycle state does not extend a staff session.

## Kiosk operation

The activity enters immersive fullscreen. It calls `startLockTask()` only when Android reports that the package is allowlisted by device-owner policy. Full kiosk deployment therefore requires ordinary Android Enterprise/device-owner provisioning and a policy that allowlists `at.makerspace.core.terminal` for Lock Task.

Hold Volume Up and Volume Down for two seconds to request administrative exit. Android device credentials are required before Lock Task is stopped and registration settings are shown. The credential-less fallback exists only in debug builds.

Release builds disable the NFC simulator and WebView debugging and enable shrinking. Production work still includes organization-specific signing, managed configuration/distribution, device-owner enrollment, certificate trust, lifecycle monitoring, and validation on the selected tablet and NFC tag families.

Build an unsigned, shrunk release artifact with `./gradlew assembleRelease` from `android-terminal/`. Production distribution must add the organization's release signing configuration outside the repository. When a physical tablet becomes available, register it with a new device token, verify NFC tag families and orientation, provision a device owner, allowlist the package for Lock Task, and validate the administrative exit with the deployed device credential.

The terminal contains no SMS relay, WhatsApp integration, printer connector, filament inventory, or Bambu integration. Notification delivery remains behind the server's existing provider abstraction.
