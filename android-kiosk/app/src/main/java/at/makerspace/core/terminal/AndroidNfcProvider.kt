package at.makerspace.core.terminal

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag
import java.util.Locale

class AndroidNfcProvider(
    private val adapter: NfcAdapter?,
    private val events: BridgeEventFactory,
) : NfcProvider {
    override fun capability(): HardwareCapability = when {
        adapter == null -> HardwareCapability("nfc", false, "unsupported", "This Android device has no NFC adapter")
        !adapter.isEnabled -> HardwareCapability("nfc", false, "unavailable", "Android NFC is disabled")
        else -> HardwareCapability("nfc", true, "ready")
    }

    override fun start(activity: Activity, callback: (JSONObjectEvent) -> Unit) {
        if (adapter == null || !adapter.isEnabled) return
        adapter.enableReaderMode(activity, { tag -> callback(JSONObjectEvent(events.scan(reading(tag)))) },
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
                NfcAdapter.FLAG_READER_NFC_F or NfcAdapter.FLAG_READER_NFC_V or
                NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
            null)
    }

    override fun stop(activity: Activity) {
        adapter?.disableReaderMode(activity)
    }

    private fun reading(tag: Tag): NfcReading {
        val uid = tag.id.joinToString("") { byte -> "%02X".format(Locale.ROOT, byte.toInt() and 0xFF) }
        val protocol = tag.techList.joinToString(",") { it.substringAfterLast('.') }
        return NfcReading(uid = uid, source = "android", protocol = protocol)
    }
}
