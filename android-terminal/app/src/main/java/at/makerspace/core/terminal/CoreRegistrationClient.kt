package at.makerspace.core.terminal

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

data class RegisteredDevice(
    val deviceId: String,
    val deviceName: String,
    val allowedModes: Set<String>,
    val terminalEnabled: Boolean,
)

class RegistrationRejectedException(
    val status: Int,
    val code: String?,
) : IOException("Makerspace Core rejected device registration")

class CoreRegistrationClient(
    private val connectionFactory: (URL) -> HttpURLConnection = { url -> url.openConnection() as HttpURLConnection },
) {
    fun report(coreURL: String, token: String, capabilities: List<HardwareCapability>): RegisteredDevice {
        require(token.matches(Regex("[A-Za-z0-9_-]{43}"))) { "Managed-device token is invalid" }
        val body = JSONObject()
            .put("platform", "android")
            .put("bridgeVersion", BuildConfig.VERSION_NAME)
            .put("capabilities", JSONArray(capabilities.filter { it.available && it.state != "simulated" }.map { it.id }))
            .toString()
        val connection = connectionFactory(URL(coreURL.trimEnd('/') + "/api/v1/managed-devices/self/hardware")).apply {
            requestMethod = "PUT"
            connectTimeout = 15_000
            readTimeout = 15_000
            doOutput = true
            useCaches = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("X-Managed-Device-Token", token)
        }
        try {
            val encodedBody = body.toByteArray(Charsets.UTF_8)
            connection.setFixedLengthStreamingMode(encodedBody.size)
            connection.outputStream.use { it.write(encodedBody) }
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) {
                val problem = readLimited(connection.errorStream, 4_096)
                val code = runCatching { JSONObject(problem).optString("code").takeIf(String::isNotBlank) }.getOrNull()
                throw RegistrationRejectedException(status, code)
            }
            val response = readLimited(connection.inputStream, 64 * 1_024)
            val parsed = JSONObject(response)
            val modes = parsed.getJSONArray("allowedApplicationModes")
            val allowed = buildSet { for (index in 0 until modes.length()) add(modes.getString(index)) }
            require(allowed.isNotEmpty() && allowed.all { it == "visitor_terminal" || it == "staff_ui" })
            return RegisteredDevice(
                deviceId = parsed.getString("deviceId"),
                deviceName = parsed.getString("deviceName"),
                allowedModes = allowed,
                terminalEnabled = parsed.getBoolean("terminalEnabled"),
            )
        } finally {
            connection.disconnect()
        }
    }
}

fun registrationErrorMessage(error: Throwable): String = when (error) {
    is RegistrationRejectedException -> when {
        error.status == HttpURLConnection.HTTP_UNAUTHORIZED ->
            "The managed-device credential is invalid, expired, or revoked. Rotate the device token and register again."
        error.code == "origin_invalid" ->
            "Makerspace Core rejected the native hardware request. Update the server to a version that supports native device registration."
        error.status == HttpURLConnection.HTTP_FORBIDDEN ->
            "This managed device is not allowed to report hardware. Check its status and server policy."
        error.status == HttpURLConnection.HTTP_NOT_FOUND ->
            "The configured Makerspace Core server does not provide the device registration endpoint."
        error.status == 422 ->
            "Makerspace Core rejected the hardware report. Check the app and server versions."
        else -> "Makerspace Core rejected device registration (HTTP ${error.status})."
    }
    is IllegalArgumentException -> error.message ?: "The registration details are invalid."
    is IllegalStateException -> error.message ?: "The device registration could not be stored."
    is IOException -> "Makerspace Core could not be reached. Check the URL and network connection."
    else -> "Makerspace Core returned an invalid device registration response."
}

fun shouldClearStoredRegistration(error: Throwable): Boolean =
    error is RegistrationRejectedException && error.status == HttpURLConnection.HTTP_UNAUTHORIZED

private fun readLimited(stream: InputStream?, maximumCharacters: Int): String {
    if (stream == null) return ""
    return stream.bufferedReader(Charsets.UTF_8).use { reader ->
        val result = StringBuilder()
        val buffer = CharArray(1_024)
        while (result.length < maximumCharacters) {
            val count = reader.read(buffer, 0, minOf(buffer.size, maximumCharacters - result.length))
            if (count < 0) break
            result.append(buffer, 0, count)
        }
        result.toString()
    }
}
