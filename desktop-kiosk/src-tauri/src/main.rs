use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, webview::Cookie};
use tauri_plugin_shell::{ShellExt, process::CommandChild};
use url::Url;

const BRIDGE_URL: &str = "http://127.0.0.1:17321";
const CREDENTIAL_SERVICE: &str = "at.makerspace.core.desktop";
const CREDENTIAL_ACCOUNT: &str = "managed-device";
const MAX_CONFIG_BYTES: u64 = 16 * 1024;
const PAIRING_SECRET_HEADER: &str = "X-Device-Pairing-Secret";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredRegistration {
    core_url: String,
    initial_path: String,
    device_id: String,
    device_name: String,
    simulator: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceHardwareContext {
    device_id: String,
    device_name: String,
    #[serde(rename = "terminalEnabled")]
    kiosk_enabled: bool,
    allowed_application_modes: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct APIProblem {
    code: Option<String>,
}

// No Debug: these responses carry the poll secret and the device token, which must never reach a log.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingStartResponse {
    code: String,
    expires_at: String,
    poll_secret: Option<String>,
}

#[derive(Deserialize)]
struct PairingPollResponse {
    status: String,
    token: Option<String>,
}

/// What the registration page shows while a pairing code is open.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingCode {
    code: String,
    expires_at: String,
}

/// The open pairing request. The poll secret stays in the native process; the registration page never sees it, nor
/// the token that a successful poll returns.
struct PendingPairing {
    core: Url,
    poll_secret: String,
    simulator: bool,
    /// Core hands out the token only once. If storing it fails (bridge, credential store), it is kept here so that
    /// the next poll retries the registration instead of losing the credential.
    received_token: Option<String>,
}

struct AppState {
    bridge: Mutex<Option<CommandChild>>,
    core_origin: Arc<RwLock<Option<String>>>,
    config_path: PathBuf,
    pairing_path: PathBuf,
    startup_error: Mutex<Option<String>>,
    pending_pairing: Mutex<Option<PendingPairing>>,
}

#[tauri::command]
fn take_startup_error(state: State<'_, AppState>) -> Result<Option<String>, String> {
    state
        .startup_error
        .lock()
        .map(|mut value| value.take())
        .map_err(|_| "Desktop startup state is unavailable.".to_owned())
}

#[tauri::command]
async fn register_device(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    core_url: String,
    token: String,
    simulator: bool,
) -> Result<(), String> {
    let core = validate_core_url(&core_url)?;
    validate_token(&token)?;
    complete_registration(&app, &window, &state, &core, &token, simulator).await
}

/// Requests a pairing code from Core for this desktop. Staff enter the code under Settings › Devices & sessions ›
/// Pair device; `poll_pairing` then collects the one-time native token.
#[tauri::command]
async fn start_pairing(
    state: State<'_, AppState>,
    core_url: String,
    simulator: bool,
) -> Result<PairingCode, String> {
    let core = validate_core_url(&core_url)?;
    // A request still open against the same Core is replaced instead of piling up.
    let previous = state
        .pending_pairing
        .lock()
        .map_err(|_| "The pairing state is unavailable.".to_owned())?
        .take()
        .filter(|pending| origin(&pending.core) == origin(&core))
        .map(|pending| pending.poll_secret);
    let mut request = http_client()?
        .post(pairing_endpoint(&core)?)
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "credentialDelivery": "nativeToken" }));
    if let Some(secret) = &previous {
        request = request.header(PAIRING_SECRET_HEADER, secret);
    }
    let response = request.send().await.map_err(|_| unreachable_core())?;
    if !response.status().is_success() {
        return Err(pairing_error(response).await);
    }
    let start = response
        .json::<PairingStartResponse>()
        .await
        .map_err(|_| "Makerspace Core returned an invalid pairing response.".to_owned())?;
    let poll_secret = start
        .poll_secret
        .filter(|secret| validate_token(secret).is_ok())
        .ok_or_else(|| "Makerspace Core returned an invalid pairing response.".to_owned())?;
    *state
        .pending_pairing
        .lock()
        .map_err(|_| "The pairing state is unavailable.".to_owned())? = Some(PendingPairing {
        core,
        poll_secret,
        simulator: simulator && cfg!(debug_assertions),
        received_token: None,
    });
    Ok(PairingCode {
        code: start.code,
        expires_at: start.expires_at,
    })
}

/// Polls the open pairing request: `pending`, `expired` (request a new code), or `paired` once the one-time token was
/// received and stored exactly like a manually entered token.
#[tauri::command]
async fn poll_pairing(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (core, poll_secret, simulator, received_token) = {
        let pending = state
            .pending_pairing
            .lock()
            .map_err(|_| "The pairing state is unavailable.".to_owned())?;
        let pending = pending
            .as_ref()
            .ok_or_else(|| "No pairing code is open.".to_owned())?;
        (
            pending.core.clone(),
            pending.poll_secret.clone(),
            pending.simulator,
            pending.received_token.clone(),
        )
    };
    if let Some(token) = received_token {
        return finish_pairing(&app, &window, &state, &core, &token, simulator).await;
    }
    let response = http_client()?
        .get(pairing_endpoint(&core)?)
        .header("Accept", "application/json")
        .header(PAIRING_SECRET_HEADER, &poll_secret)
        .send()
        .await
        .map_err(|_| unreachable_core())?;
    if !response.status().is_success() {
        return Err(pairing_error(response).await);
    }
    let poll = response
        .json::<PairingPollResponse>()
        .await
        .map_err(|_| "Makerspace Core returned an invalid pairing response.".to_owned())?;
    match poll.status.as_str() {
        "pending" => Ok("pending".to_owned()),
        "paired" => {
            let Some(token) = poll.token.filter(|token| validate_token(token).is_ok()) else {
                clear_pending_pairing(&state);
                return Err("Makerspace Core did not deliver a valid device credential.".to_owned());
            };
            if let Ok(mut pending) = state.pending_pairing.lock()
                && let Some(pending) = pending.as_mut()
            {
                pending.received_token = Some(token.clone());
            }
            finish_pairing(&app, &window, &state, &core, &token, simulator).await
        }
        _ => {
            clear_pending_pairing(&state);
            Ok("expired".to_owned())
        }
    }
}

/// Registers with the received token; the pending request (and the token) is dropped only once that succeeded.
async fn finish_pairing(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    state: &AppState,
    core: &Url,
    token: &str,
    simulator: bool,
) -> Result<String, String> {
    complete_registration(app, window, state, core, token, simulator)
        .await
        .map_err(|message| format!("{message} Retrying…"))?;
    clear_pending_pairing(state);
    Ok("paired".to_owned())
}

fn clear_pending_pairing(state: &AppState) {
    if let Ok(mut pending) = state.pending_pairing.lock() {
        *pending = None;
    }
}

/// Verifies the credential with Core, stores it in the operating-system credential store, starts the bridge and
/// opens Core. Manual token entry and pairing share this path.
async fn complete_registration(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    state: &AppState,
    core: &Url,
    token: &str,
    simulator: bool,
) -> Result<(), String> {
    let identity = fetch_device_identity(core, token).await?;
    let initial_path = initial_path(&identity).to_owned();
    let registration = StoredRegistration {
        core_url: normalized_core_url(core),
        initial_path: initial_path.clone(),
        device_id: identity.device_id,
        device_name: identity.device_name,
        simulator: simulator && cfg!(debug_assertions),
    };
    *state
        .core_origin
        .write()
        .map_err(|_| "Desktop navigation state is unavailable.".to_owned())? = Some(origin(core));
    let entry = credential_entry()?;
    start_ready_bridge(app, state, &registration, token).await?;
    if entry.set_password(token).is_err() {
        stop_bridge(state);
        return Err(
            "The operating-system credential store rejected the managed-device credential."
                .to_owned(),
        );
    }
    if let Err(message) = store_registration(&state.config_path, &registration) {
        let _ = entry.delete_credential();
        stop_bridge(state);
        return Err(message);
    }
    install_device_cookie(window, core, token)?;
    window
        .navigate(
            core.join(&initial_path)
                .map_err(|_| "The initial Core route is invalid.".to_owned())?,
        )
        .map_err(|_| "The desktop window could not open Makerspace Core.".to_owned())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "The registration client could not start.".to_owned())
}

fn pairing_endpoint(core: &Url) -> Result<Url, String> {
    core.join("api/v1/public/managed-devices/pairing")
        .map_err(|_| "The Makerspace Core pairing endpoint is invalid.".to_owned())
}

fn unreachable_core() -> String {
    "Makerspace Core could not be reached. Check the URL and network connection.".to_owned()
}

async fn pairing_error(response: reqwest::Response) -> String {
    let status = response.status().as_u16();
    let code = response
        .json::<APIProblem>()
        .await
        .ok()
        .and_then(|problem| problem.code);
    pairing_error_message(status, code.as_deref())
}

fn pairing_error_message(status: u16, code: Option<&str>) -> String {
    match (status, code) {
        (403, Some("pairing_network_denied")) => {
            "This network may not register kiosks. Connect the desktop to the makerspace network."
                .to_owned()
        }
        (409, Some("pairing_claimed")) => {
            "This desktop was already paired. Wait a moment and try again.".to_owned()
        }
        (429, _) => "Too many pairing requests. Wait a few minutes and try again.".to_owned(),
        (404, _) => "This Makerspace Core does not support pairing yet. Enter a managed-device token instead."
            .to_owned(),
        _ => format!("Makerspace Core rejected the pairing request (HTTP {status})."),
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            register_device,
            start_pairing,
            poll_pairing,
            take_startup_error
        ])
        .setup(|app| {
            let config_directory = app.path().app_config_dir()?;
            fs::create_dir_all(&config_directory)?;
            let config_path = config_directory.join("registration.json");
            let pairing_path = config_directory.join("device-bridge.key");
            if std::env::var_os("MAKERSPACE_DESKTOP_RESET_REGISTRATION").is_some() {
                let _ = fs::remove_file(&config_path);
                if let Ok(entry) = credential_entry() {
                    let _ = entry.delete_credential();
                }
            }
            let pairing_key = load_or_create_pairing_key(&pairing_path)?;
            let stored = load_registration(&config_path).ok();
            let token = credential_entry().ok().and_then(|entry| entry.get_password().ok());
            let core = stored.as_ref().and_then(|registration| validate_core_url(&registration.core_url).ok());
            let core_origin = Arc::new(RwLock::new(core.as_ref().map(origin)));
            app.manage(AppState {
                bridge: Mutex::new(None),
                core_origin: Arc::clone(&core_origin),
                config_path,
                pairing_path,
                startup_error: Mutex::new(None),
                pending_pairing: Mutex::new(None),
            });

            let injected = serde_json::to_string(&serde_json::json!({
                "baseURL": BRIDGE_URL,
                "pairingKey": pairing_key,
            }))?;
            let navigation_origin = Arc::clone(&core_origin);
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Makerspace Core Desktop")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .initialization_script(format!(
                    "if (window.top === window) {{ window.makerspaceDesktopBridge = {injected}; window.makerspaceDesktopDebug = {}; }}",
                    cfg!(debug_assertions)
                ))
                .on_navigation(move |url| navigation_allowed(url, &navigation_origin))
                .build()?;

            if let (Some(mut registration), Some(token), Some(core)) = (stored, token, core) {
                let handle = app.handle().clone();
                let startup_window = window.clone();
                tauri::async_runtime::spawn(async move {
                    let result = async {
                        let identity = fetch_device_identity(&core, &token).await?;
                        registration.initial_path = initial_path(&identity).to_owned();
                        let state = handle.state::<AppState>();
                        start_ready_bridge(&handle, &state, &registration, &token).await?;
                        store_registration(&state.config_path, &registration)?;
                        install_device_cookie(&startup_window, &core, &token)?;
                        startup_window.navigate(core.join(&registration.initial_path)
                            .map_err(|_| "The initial Core route is invalid.".to_owned())?)
                            .map_err(|_| "The desktop window could not open Makerspace Core.".to_owned())
                    }.await;
                    if let Err(message) = result {
                        show_registration_error(&startup_window, &message);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Makerspace Core Desktop");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit)
            && let Some(state) = handle.try_state::<AppState>()
        {
            stop_bridge(&state);
        }
    });
}

fn start_bridge(
    app: &tauri::AppHandle,
    state: &AppState,
    registration: &StoredRegistration,
    token: &str,
) -> Result<(), String> {
    {
        let mut active = state
            .bridge
            .lock()
            .map_err(|_| "The hardware bridge state is unavailable.".to_owned())?;
        if let Some(previous) = active.take() {
            let _ = previous.kill();
        }
    }
    let mut arguments = vec![
        "--listen".to_owned(),
        "127.0.0.1:17321".to_owned(),
        "--origins".to_owned(),
        origin(&validate_core_url(&registration.core_url)?),
        "--pairing-key-file".to_owned(),
        state.pairing_path.to_string_lossy().into_owned(),
        "--core-url".to_owned(),
        registration.core_url.clone(),
        "--device-token-stdin".to_owned(),
    ];
    if registration.simulator && cfg!(debug_assertions) {
        arguments.push("--simulator".to_owned());
    }
    let (mut receiver, mut child) = app
        .shell()
        .sidecar("device-bridge")
        .map_err(|_| "The bundled hardware bridge is unavailable.".to_owned())?
        .args(arguments)
        .spawn()
        .map_err(|_| "The bundled hardware bridge could not start.".to_owned())?;
    if child.write(format!("{token}\n").as_bytes()).is_err() {
        let _ = child.kill();
        return Err(
            "The device credential could not be delivered to the hardware bridge.".to_owned(),
        );
    }
    tauri::async_runtime::spawn(async move { while receiver.recv().await.is_some() {} });
    let mut active = state
        .bridge
        .lock()
        .map_err(|_| "The hardware bridge state is unavailable.".to_owned())?;
    *active = Some(child);
    Ok(())
}

async fn start_ready_bridge(
    app: &tauri::AppHandle,
    state: &AppState,
    registration: &StoredRegistration,
    token: &str,
) -> Result<(), String> {
    start_bridge(app, state, registration, token)?;
    if let Err(message) = wait_for_bridge().await {
        stop_bridge(state);
        return Err(message);
    }
    Ok(())
}

fn stop_bridge(state: &AppState) {
    if let Ok(mut bridge) = state.bridge.lock()
        && let Some(child) = bridge.take()
    {
        let _ = child.kill();
    }
}

fn show_registration_error(window: &WebviewWindow, message: &str) {
    if let Ok(mut startup_error) = window.state::<AppState>().startup_error.lock() {
        *startup_error = Some(message.to_owned());
    }
    if let Ok(encoded) = serde_json::to_string(message) {
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('makerspace:desktop-registration-error', {{ detail: {encoded} }}));"
        ));
    }
}

async fn wait_for_bridge() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|_| "The hardware bridge health client could not start.".to_owned())?;
    for _ in 0..30 {
        if client
            .get(format!("{BRIDGE_URL}/health"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return Ok(());
        }
        tokio_sleep(Duration::from_millis(100)).await;
    }
    Err("The bundled hardware bridge did not become ready.".to_owned())
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

async fn fetch_device_identity(core: &Url, token: &str) -> Result<DeviceHardwareContext, String> {
    let endpoint = core
        .join("api/v1/managed-devices/self/hardware")
        .map_err(|_| "The Makerspace Core device endpoint is invalid.".to_owned())?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "The registration client could not start.".to_owned())?
        .get(endpoint)
        .header("Accept", "application/json")
        .header("X-Managed-Device-Token", token)
        .send()
        .await
        .map_err(|_| {
            "Makerspace Core could not be reached. Check the URL and network connection.".to_owned()
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let code = response
            .json::<APIProblem>()
            .await
            .ok()
            .and_then(|problem| problem.code);
        return Err(match status.as_u16() {
            401 => "The managed-device credential is invalid, expired, or revoked. Rotate the device token and register again.".to_owned(),
            403 => format!("Makerspace Core denied desktop registration{}.", code.map(|value| format!(" ({value})")).unwrap_or_default()),
            404 => "The configured server does not provide the Managed Device hardware endpoint.".to_owned(),
            _ => format!("Makerspace Core rejected desktop registration (HTTP {}).", status.as_u16()),
        });
    }
    response
        .json::<DeviceHardwareContext>()
        .await
        .map_err(|_| "Makerspace Core returned an invalid device registration response.".to_owned())
}

fn validate_core_url(value: &str) -> Result<Url, String> {
    validate_core_url_for_mode(value, cfg!(debug_assertions))
}

fn validate_core_url_for_mode(value: &str, allow_loopback_http: bool) -> Result<Url, String> {
    let parsed =
        Url::parse(value.trim()).map_err(|_| "The Makerspace Core URL is invalid.".to_owned())?;
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(
            "Use the Makerspace Core origin without credentials, a path, query, or fragment."
                .to_owned(),
        );
    }
    let loopback = matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if parsed.scheme() != "https" && !(allow_loopback_http && parsed.scheme() == "http" && loopback)
    {
        return Err(
            if parsed.scheme() == "http" && loopback && !allow_loopback_http {
                "This production build requires an HTTPS Makerspace Core URL. For local loopback HTTP testing, start the desktop app with `pnpm dev`.".to_owned()
            } else {
                "Makerspace Core must use HTTPS. Debug builds permit HTTP only for localhost, 127.0.0.1, or ::1.".to_owned()
            },
        );
    }
    Ok(parsed)
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.len() != 43
        || !token
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'_' || value == b'-')
    {
        return Err("The managed-device token is invalid.".to_owned());
    }
    Ok(())
}

fn navigation_allowed(url: &Url, configured: &Arc<RwLock<Option<String>>>) -> bool {
    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return true;
    }
    configured
        .read()
        .ok()
        .and_then(|value| value.clone())
        .is_some_and(|allowed| origin(url) == allowed)
}

fn initial_path(identity: &DeviceHardwareContext) -> &'static str {
    if identity.kiosk_enabled
        && identity
            .allowed_application_modes
            .iter()
            .any(|mode| mode == "visitor_terminal")
    {
        "kiosk"
    } else {
        "login"
    }
}

fn normalized_core_url(url: &Url) -> String {
    url.as_str().trim_end_matches('/').to_owned()
}

fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn install_device_cookie(window: &WebviewWindow, core: &Url, token: &str) -> Result<(), String> {
    window.set_cookie(device_cookie(core, token)?).map_err(|_| {
        "The managed-device cookie could not be installed in the desktop WebView.".to_owned()
    })
}

fn device_cookie(core: &Url, token: &str) -> Result<Cookie<'static>, String> {
    let secure = core.scheme() == "https";
    let name = if secure {
        "__Host-makerspace_device"
    } else {
        "makerspace_device"
    };
    let mut cookie = Cookie::new(name, token.to_owned());
    cookie.set_path("/");
    cookie.set_http_only(true);
    cookie.set_secure(secure);
    cookie.set_same_site(tauri::webview::cookie::SameSite::Strict);
    // Native WebView cookie stores require an explicit host. Supplying the exact
    // host (without a leading dot) keeps the cookie scoped to this Core origin.
    cookie.set_domain(
        core.host_str()
            .ok_or_else(|| "The Core URL has no host.".to_owned())?,
    );
    Ok(cookie.into_owned())
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT)
        .map_err(|_| "The operating-system credential store is unavailable.".to_owned())
}

fn store_registration(path: &Path, registration: &StoredRegistration) -> Result<(), String> {
    let encoded = serde_json::to_vec_pretty(registration)
        .map_err(|_| "The desktop registration could not be encoded.".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    write_private_file(&temporary, &encoded)?;
    fs::rename(&temporary, path)
        .map_err(|_| "The desktop registration could not be saved.".to_owned())
}

fn load_registration(path: &Path) -> Result<StoredRegistration, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Desktop registration is not configured.".to_owned())?;
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err("The desktop registration file is invalid.".to_owned());
    }
    let value =
        fs::read(path).map_err(|_| "The desktop registration could not be read.".to_owned())?;
    serde_json::from_slice(&value)
        .map_err(|_| "The desktop registration file is invalid.".to_owned())
}

fn load_or_create_pairing_key(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    if let Ok(value) = fs::read_to_string(path) {
        let value = value.trim().to_owned();
        if value.len() >= 32 {
            return Ok(value);
        }
    }
    let mut random = [0_u8; 32];
    rand::rng().fill_bytes(&mut random);
    let value = URL_SAFE_NO_PAD.encode(random);
    write_private_file(path, format!("{value}\n").as_bytes()).map_err(std::io::Error::other)?;
    Ok(value)
}

fn write_private_file(path: &Path, value: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "A private desktop configuration file could not be opened.".to_owned())?;
    file.write_all(value)
        .map_err(|_| "A private desktop configuration file could not be written.".to_owned())?;
    file.sync_all()
        .map_err(|_| "A private desktop configuration file could not be saved.".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_url_rules_reject_credentials_and_paths() {
        assert!(validate_core_url_for_mode("https://core.example.org/", false).is_ok());
        assert!(validate_core_url_for_mode("https://user@core.example.org/", false).is_err());
        assert!(validate_core_url_for_mode("https://core.example.org/subpath", false).is_err());
    }

    #[test]
    fn production_rejects_loopback_http_with_actionable_error() {
        assert_eq!(
            validate_core_url_for_mode("http://localhost:5173", false).unwrap_err(),
            "This production build requires an HTTPS Makerspace Core URL. For local loopback HTTP testing, start the desktop app with `pnpm dev`."
        );
    }

    #[test]
    fn debug_accepts_only_exact_loopback_http_hosts() {
        for url in [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://[::1]:5173",
        ] {
            assert!(validate_core_url_for_mode(url, true).is_ok(), "{url}");
        }
        assert!(validate_core_url_for_mode("http://localhost.example:5173", true).is_err());
        assert!(validate_core_url_for_mode("http://192.168.1.5:5173", true).is_err());
    }

    #[test]
    fn navigation_is_limited_to_the_configured_origin() {
        let allowed = Arc::new(RwLock::new(Some("https://core.example.org".to_owned())));
        assert!(navigation_allowed(
            &Url::parse("https://core.example.org/kiosk").unwrap(),
            &allowed
        ));
        assert!(!navigation_allowed(
            &Url::parse("https://core.example.org.evil.test/").unwrap(),
            &allowed
        ));
        assert!(!navigation_allowed(
            &Url::parse("http://core.example.org/").unwrap(),
            &allowed
        ));
    }

    #[test]
    fn pairing_uses_the_public_endpoint_of_the_configured_origin() {
        let core = Url::parse("https://core.example.org/").unwrap();
        assert_eq!(
            pairing_endpoint(&core).unwrap().as_str(),
            "https://core.example.org/api/v1/public/managed-devices/pairing"
        );
    }

    #[test]
    fn pairing_errors_are_actionable() {
        assert!(pairing_error_message(403, Some("pairing_network_denied")).contains("network"));
        assert!(pairing_error_message(429, Some("rate_limited")).contains("Too many"));
        assert!(pairing_error_message(404, None).contains("token instead"));
        assert_eq!(
            pairing_error_message(500, None),
            "Makerspace Core rejected the pairing request (HTTP 500)."
        );
    }

    #[test]
    fn pairing_code_for_the_page_omits_the_poll_secret() {
        let start: PairingStartResponse = serde_json::from_str(
            r#"{"code":"K7F2QX","expiresAt":"2026-11-09T10:15:00Z","pollSecret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
        )
        .unwrap();
        assert!(
            start
                .poll_secret
                .as_deref()
                .is_some_and(|secret| validate_token(secret).is_ok())
        );
        let shown = serde_json::to_string(&PairingCode {
            code: start.code,
            expires_at: start.expires_at,
        })
        .unwrap();
        assert_eq!(
            shown,
            r#"{"code":"K7F2QX","expiresAt":"2026-11-09T10:15:00Z"}"#
        );
        let poll: PairingPollResponse = serde_json::from_str(r#"{"status":"pending"}"#).unwrap();
        assert_eq!(poll.status, "pending");
        assert!(poll.token.is_none());
    }

    #[test]
    fn managed_device_token_shape_is_checked_without_echoing_it() {
        assert!(validate_token(&"a".repeat(43)).is_ok());
        assert_eq!(
            validate_token("secret value").unwrap_err(),
            "The managed-device token is invalid."
        );
    }

    #[test]
    fn production_device_cookie_is_http_only_secure_and_exact_host() {
        let cookie = device_cookie(
            &Url::parse("https://core.example.org/").unwrap(),
            &"a".repeat(43),
        )
        .unwrap();
        assert_eq!(cookie.name(), "__Host-makerspace_device");
        assert_eq!(cookie.domain(), Some("core.example.org"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(
            cookie.same_site(),
            Some(tauri::webview::cookie::SameSite::Strict)
        );
    }
}
