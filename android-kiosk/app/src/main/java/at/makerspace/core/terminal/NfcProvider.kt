package at.makerspace.core.terminal

import android.app.Activity

interface NfcProvider {
    fun capability(): HardwareCapability
    fun start(activity: Activity, callback: (JSONObjectEvent) -> Unit)
    fun stop(activity: Activity)
}

@JvmInline
value class JSONObjectEvent(val value: org.json.JSONObject)
