package at.makerspace.core.terminal

import android.net.Uri
import java.net.URI

class BridgeAccessPolicy private constructor(val trustedOrigin: String) {
    fun permits(sourceOrigin: Uri, isMainFrame: Boolean): Boolean = isMainFrame && sourceOrigin.toString() == trustedOrigin

    fun permitsNavigation(url: String): Boolean = runCatching { originOf(url) == trustedOrigin }.getOrDefault(false)

    companion object {
        fun fromCoreURL(coreURL: String, allowDebugHTTP: Boolean): BridgeAccessPolicy {
            val parsed = URI(coreURL.trim())
            require(parsed.userInfo == null && parsed.query == null && parsed.fragment == null && parsed.host != null) { "Core URL is invalid" }
            val loopback = parsed.host == "localhost" || parsed.host == "127.0.0.1" || parsed.host == "10.0.2.2" || parsed.host == "::1"
            require(parsed.scheme == "https" || (allowDebugHTTP && parsed.scheme == "http" && loopback)) { "Core URL must use HTTPS" }
            return BridgeAccessPolicy(originOf(parsed.toString()))
        }

        fun originOf(value: String): String {
            val uri = URI(value)
            val defaultPort = (uri.scheme == "https" && uri.port == 443) || (uri.scheme == "http" && uri.port == 80) || uri.port == -1
            val host = if (uri.host.contains(':')) "[${uri.host}]" else uri.host
            return "${uri.scheme}://$host${if (defaultPort) "" else ":${uri.port}"}"
        }
    }
}
