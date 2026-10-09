package at.makerspace.core.terminal

import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.app.KeyguardManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.nfc.NfcAdapter
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var offlineBanner: TextView
    private lateinit var store: SecureDeviceStore
    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val events = BridgeEventFactory()
    private val pendingEvents = ArrayDeque<JSONObject>()
    private lateinit var androidNfc: AndroidNfcProvider
    private lateinit var simulatorNfc: SimulatorNfcProvider
    private var policy: BridgeAccessPolicy? = null
    private var configured: StoredDevice? = null
    private var coreConnected = false
    private var pageReady = false
    private var volumeUp = false
    private var volumeDown = false
    private var adminExitScheduled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SecureDeviceStore(this)
        androidNfc = AndroidNfcProvider(NfcAdapter.getDefaultAdapter(this), events)
        simulatorNfc = SimulatorNfcProvider(events)
        buildView()
        enterFullscreen()
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val stored = store.load()
        if (stored == null) showSetup() else configureWeb(stored, savedInstanceState)
    }

    override fun onResume() {
        super.onResume()
        androidNfc.start(this, ::emit)
        if (BuildConfig.ENABLE_NFC_SIMULATOR) simulatorNfc.start(this, ::emit)
        enterManagedLockTaskIfPermitted()
    }

    override fun onPause() {
        androidNfc.stop(this)
        simulatorNfc.stop(this)
        super.onPause()
    }

    override fun onDestroy() {
        executor.shutdownNow()
        webView.destroy()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Suppress("DEPRECATION")
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) volumeUp = true
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) volumeDown = true
        if (volumeUp && volumeDown && !adminExitScheduled) {
            adminExitScheduled = true
            mainHandler.postDelayed({ if (volumeUp && volumeDown) requestAdministrativeExit(); adminExitScheduled = false }, 2_000)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) volumeUp = false
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) volumeDown = false
        return super.onKeyUp(keyCode, event)
    }

    @Deprecated("Uses the platform device credential result for the controlled kiosk exit")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == ADMIN_EXIT_REQUEST && resultCode == RESULT_OK) {
            if ((getSystemService(ACTIVITY_SERVICE) as ActivityManager).lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) stopLockTask()
            showSetup(configured)
        }
    }

    @Suppress("DEPRECATION")
    private fun buildView() {
        val root = FrameLayout(this)
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        offlineBanner = TextView(this).apply {
            setBackgroundColor(Color.rgb(218, 30, 40))
            setTextColor(Color.WHITE)
            setPadding(24, 16, 24, 16)
            text = "Makerspace Core is unreachable. Tap to retry."
            visibility = View.GONE
            setOnClickListener {
                configured?.let(::reportCapabilities)
                webView.reload()
            }
        }
        root.addView(offlineBanner, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        if (BuildConfig.ENABLE_NFC_SIMULATOR) {
            val simulator = Button(this).apply { text = "NFC simulator"; setOnClickListener { showSimulator() } }
            root.addView(simulator, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.END).apply { setMargins(16, 16, 16, 16) })
        }
        setContentView(root)
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) WebViewCompat.startSafeBrowsing(this) { }
    }

    private fun configureWeb(device: StoredDevice, savedState: Bundle? = null) {
        val access = runCatching { BridgeAccessPolicy.fromCoreURL(device.coreURL, BuildConfig.DEBUG) }.getOrElse {
            store.clear(); showSetup(); return
        }
        configured = device
        policy = access
        pageReady = false
        installDeviceCookie(device)
        installBridge(access)
        webView.webViewClient = RestrictedWebViewClient(access)
        val restored = savedState != null && webView.restoreState(savedState) != null
        if (!restored) webView.loadUrl(device.coreURL.trimEnd('/') + initialPath(device))
        reportCapabilities(device)
    }

    private fun installBridge(access: BridgeAccessPolicy) {
        require(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { "Installed WebView does not support the secure native bridge" }
        runCatching { WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME) }
        WebViewCompat.addWebMessageListener(webView, BRIDGE_NAME, setOf(access.trustedOrigin)) { _, message, sourceOrigin, isMainFrame, _ ->
            if (!access.permits(sourceOrigin, isMainFrame)) return@addWebMessageListener
            val data = message.data ?: return@addWebMessageListener
            val request = runCatching { JSONObject(data) }.getOrNull() ?: return@addWebMessageListener
            val id = request.optString("id")
            if (request.optInt("protocolVersion") != 1 || id.isBlank()) return@addWebMessageListener
            when (request.optString("method")) {
                "getDeviceInfo" -> sendToWeb(JSONObject().put("id", id).put("result", deviceInfoJSON(capabilities(), coreConnected, configured?.deviceName)))
                else -> sendToWeb(JSONObject().put("id", id).put("error", JSONObject().put("code", "unsupported").put("message", "Unsupported native bridge method")))
            }
        }
    }

    private fun reportCapabilities(device: StoredDevice) {
        executor.execute {
            try {
                val identity = CoreRegistrationClient().report(device.coreURL, device.token, capabilities())
                store.save(device.coreURL, device.token, identity)
                configured = store.load()
                coreConnected = true
                runOnUiThread {
                    offlineBanner.text = "Makerspace Core is unreachable. Tap to retry."
                    offlineBanner.visibility = View.GONE
                }
            } catch (rejected: RegistrationRejectedException) {
                coreConnected = false
                if (shouldClearStoredRegistration(rejected)) {
                    store.clear()
                    runOnUiThread {
                        CookieManager.getInstance().removeAllCookies(null)
                        Toast.makeText(this, registrationErrorMessage(rejected), Toast.LENGTH_LONG).show()
                        showSetup()
                    }
                } else runOnUiThread { showRegistrationFailure(rejected) }
            } catch (failure: Exception) {
                coreConnected = false
                runOnUiThread { showRegistrationFailure(failure) }
            }
        }
    }

    private fun showRegistrationFailure(failure: Throwable) {
        offlineBanner.text = registrationErrorMessage(failure) + " Tap to retry."
        offlineBanner.visibility = View.VISIBLE
    }

    private fun capabilities(): List<HardwareCapability> {
        val physical = androidNfc.capability()
        return listOf(if (physical.available || !BuildConfig.ENABLE_NFC_SIMULATOR) physical else simulatorNfc.capability())
    }

    private fun emit(event: JSONObjectEvent) {
        runOnUiThread {
            if (!pageReady) {
                if (pendingEvents.size >= 32) pendingEvents.removeFirst()
                pendingEvents.addLast(event.value)
            } else sendToWeb(JSONObject().put("event", event.value))
        }
    }

    private fun sendToWeb(message: JSONObject) {
        val script = "window.dispatchEvent(new CustomEvent('makerspace:device-bridge-message',{detail:JSON.parse(${JSONObject.quote(message.toString())})}))"
        webView.evaluateJavascript(script, null)
    }

    private fun installDeviceCookie(device: StoredDevice) {
        val secure = device.coreURL.startsWith("https://")
        val name = if (secure) "__Host-makerspace_device" else "makerspace_device"
        val attributes = if (secure) "; Secure" else ""
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setCookie(device.coreURL, "$name=${device.token}; Path=/; HttpOnly; SameSite=Strict$attributes")
            flush()
        }
    }

    private fun initialPath(device: StoredDevice): String =
        if (device.terminalEnabled && device.allowedModes.contains("visitor_terminal")) "/terminal" else "/login"

    private fun showSetup(existing: StoredDevice? = null) {
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 16, 48, 0) }
        val url = EditText(this).apply { hint = "https://core.example.org"; setText(existing?.coreURL ?: if (BuildConfig.DEBUG) "http://10.0.2.2:8080" else "") }
        val token = EditText(this).apply { hint = "Managed-device token (shown once)"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        layout.addView(url); layout.addView(token)
        val dialog = AlertDialog.Builder(this).setTitle("Register terminal").setMessage("Create a native-token Managed Device in Makerspace Core, then enter the token shown at creation or rotation.")
            .setView(layout).setNegativeButton("Cancel", null).setPositiveButton("Register", null).create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val coreURL = url.text.toString().trim().trimEnd('/')
                val rawToken = token.text.toString().trim()
                val access = runCatching { BridgeAccessPolicy.fromCoreURL(coreURL, BuildConfig.DEBUG) }.getOrElse { Toast.makeText(this, it.message, Toast.LENGTH_LONG).show(); return@setOnClickListener }
                if (!rawToken.matches(Regex("[A-Za-z0-9_-]{43}"))) { Toast.makeText(this, "Managed-device token is invalid", Toast.LENGTH_LONG).show(); return@setOnClickListener }
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                executor.execute {
                    try {
                        val identity = CoreRegistrationClient().report(coreURL, rawToken, capabilities())
                        store.save(coreURL, rawToken, identity)
                        runOnUiThread { dialog.dismiss(); recreate() }
                    } catch (failure: Exception) {
                        runOnUiThread {
                            dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true
                            Toast.makeText(this, registrationErrorMessage(failure), Toast.LENGTH_LONG).show()
                        }
                    }
                }
                policy = access
            }
        }
        dialog.show()
    }

    private fun showSimulator() {
        val uid = EditText(this).apply { hint = "04A7310B"; setText("04A7310B"); inputType = InputType.TYPE_CLASS_TEXT }
        AlertDialog.Builder(this).setTitle("NFC simulator").setView(uid)
            .setItems(arrayOf("Scan", "Duplicate scan", "Tag removed", "Reader disconnected", "Reader reconnected", "Unsupported UID read")) { _, which ->
                runCatching {
                    when (which) {
                        0 -> simulatorNfc.scan(uid.text.toString())
                        1 -> simulatorNfc.duplicate(uid.text.toString())
                        2 -> simulatorNfc.remove()
                        3 -> simulatorNfc.disconnect()
                        4 -> simulatorNfc.reconnect()
                        5 -> simulatorNfc.unsupported()
                    }
                }.onFailure { Toast.makeText(this, it.message, Toast.LENGTH_LONG).show() }
            }.show()
    }

    @Suppress("DEPRECATION")
    private fun enterFullscreen() {
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    private fun enterManagedLockTaskIfPermitted() {
        val manager = getSystemService(DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (manager.isLockTaskPermitted(packageName) && (getSystemService(ACTIVITY_SERVICE) as ActivityManager).lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) startLockTask()
    }

    @Suppress("DEPRECATION")
    private fun requestAdministrativeExit() {
        val manager = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        val intent = manager.createConfirmDeviceCredentialIntent("Exit terminal administration", "Authenticate with the Android device credential")
        if (intent != null) startActivityForResult(intent, ADMIN_EXIT_REQUEST)
        else if (BuildConfig.DEBUG) showSetup(configured)
    }

    private inner class RestrictedWebViewClient(private val access: BridgeAccessPolicy) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
            if (access.permitsNavigation(request.url.toString())) return false
            Toast.makeText(this@MainActivity, "Navigation outside Makerspace Core was blocked", Toast.LENGTH_SHORT).show()
            return true
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            pageReady = url != null && access.permitsNavigation(url)
            if (pageReady) {
                offlineBanner.visibility = View.GONE
                while (pendingEvents.isNotEmpty()) sendToWeb(JSONObject().put("event", pendingEvents.removeFirst()))
            }
        }

        override fun onReceivedError(view: WebView?, request: WebResourceRequest, error: WebResourceError?) {
            if (request.isForMainFrame) offlineBanner.visibility = View.VISIBLE
        }

        override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: android.net.http.SslError?) {
            handler.cancel()
            offlineBanner.visibility = View.VISIBLE
        }
    }

    companion object {
        private const val BRIDGE_NAME = "makerspaceDeviceBridgeNative"
        private const val ADMIN_EXIT_REQUEST = 1942
    }
}
