package at.makerspace.core.terminal

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

data class HardwareCapability(
    val id: String,
    val available: Boolean,
    val state: String,
    val detail: String? = null,
)

data class NfcReading(
    val uid: String,
    val source: String,
    val protocol: String? = null,
)

class BridgeEventFactory {
    private val sequence = AtomicLong(0)
    private var previousUID: String? = null
    private var previousAt: Long = 0

    @Synchronized
    fun scan(reading: NfcReading, nowMillis: Long = System.currentTimeMillis()): JSONObject {
        val uid = normalizeUID(reading.uid)
        val duplicate = uid == previousUID && nowMillis - previousAt <= 1_500
        previousUID = uid
        previousAt = nowMillis
        return base("nfc_scan", reading.source, nowMillis)
            .put("reader", reader(reading.protocol))
            .put("nfc", JSONObject().put("uid", uid).put("uidFormat", "hex"))
            .put("duplicate", duplicate)
    }

    @Synchronized
    fun removed(source: String, nowMillis: Long = System.currentTimeMillis()): JSONObject {
        previousUID = null
        previousAt = 0
        return base("nfc_removed", source, nowMillis).put("reader", reader(null))
    }

    fun state(kind: String, state: String, source: String, errorCode: String? = null): JSONObject {
        return base(kind, source, System.currentTimeMillis())
            .put("reader", reader(null))
            .put("state", state)
            .apply { if (errorCode != null) put("errorCode", errorCode) }
    }

    private fun base(kind: String, source: String, nowMillis: Long) = JSONObject()
        .put("protocolVersion", 1)
        .put("sequence", sequence.incrementAndGet())
        .put("kind", kind)
        .put("occurredAt", Instant.ofEpochMilli(nowMillis).toString())
        .put("source", source)

    private fun reader(protocol: String?) = JSONObject()
        .put("id", "android-nfc")
        .put("name", "Android NFC")
        .apply { if (!protocol.isNullOrBlank()) put("protocol", protocol) }

    companion object {
        fun normalizeUID(value: String): String {
            val normalized = value.replace(Regex("[:\\-\\s]"), "").uppercase(Locale.ROOT)
            require(normalized.length in 2..64 && normalized.length % 2 == 0 && normalized.matches(Regex("[0-9A-F]+"))) {
                "NFC UID must contain 1 to 32 bytes of hexadecimal data"
            }
            return normalized
        }
    }
}

fun deviceInfoJSON(capabilities: List<HardwareCapability>, connected: Boolean, deviceName: String?): JSONObject {
    val items = JSONArray()
    capabilities.forEach { capability ->
        items.put(JSONObject()
            .put("id", capability.id)
            .put("available", capability.available)
            .put("state", capability.state)
            .apply { if (capability.detail != null) put("detail", capability.detail) })
    }
    return JSONObject()
        .put("protocolVersion", 1)
        .put("bridgeVersion", BuildConfig.VERSION_NAME)
        .put("platform", "android")
        .put("capabilities", items)
        .put("coreConnected", connected)
        .apply { if (!deviceName.isNullOrBlank()) put("deviceName", deviceName) }
}
