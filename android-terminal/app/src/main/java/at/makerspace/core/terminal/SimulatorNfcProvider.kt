package at.makerspace.core.terminal

import android.app.Activity

class SimulatorNfcProvider(private val events: BridgeEventFactory) : NfcProvider {
    private var callback: ((JSONObjectEvent) -> Unit)? = null
    override fun capability() = HardwareCapability("nfc", true, "simulated", "Debug NFC simulator")
    override fun start(activity: Activity, callback: (JSONObjectEvent) -> Unit) { this.callback = callback }
    override fun stop(activity: Activity) { callback = null }
    fun scan(uid: String) { callback?.invoke(JSONObjectEvent(events.scan(NfcReading(uid, "simulator")))) }
    fun duplicate(uid: String) { scan(uid); scan(uid) }
    fun remove() { callback?.invoke(JSONObjectEvent(events.removed("simulator"))) }
    fun disconnect() { callback?.invoke(JSONObjectEvent(events.state("reader_state", "disconnected", "simulator"))) }
    fun reconnect() { callback?.invoke(JSONObjectEvent(events.state("reader_state", "connected", "simulator"))) }
    fun unsupported() { callback?.invoke(JSONObjectEvent(events.state("capability_state", "unavailable", "simulator", "unsupported_capability"))) }
}
