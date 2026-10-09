package at.makerspace.core.terminal

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class StoredDevice(
    val coreURL: String,
    val token: String,
    val deviceName: String?,
    val allowedModes: Set<String>,
    val terminalEnabled: Boolean,
)

class SecureDeviceStore(context: Context) {
    private val preferences = context.getSharedPreferences("managed_device", Context.MODE_PRIVATE)

    fun load(): StoredDevice? {
        val coreURL = preferences.getString("core_url", null) ?: return null
        val encrypted = preferences.getString("token", null) ?: return null
        val token = runCatching { decrypt(encrypted) }.getOrNull() ?: return null
        return StoredDevice(
            coreURL = coreURL,
            token = token,
            deviceName = preferences.getString("device_name", null),
            allowedModes = preferences.getStringSet("allowed_modes", setOf("staff_ui"))?.toSet() ?: setOf("staff_ui"),
            terminalEnabled = preferences.getBoolean("terminal_enabled", false),
        )
    }

    fun save(coreURL: String, token: String, identity: RegisteredDevice) {
        check(preferences.edit()
            .putString("core_url", coreURL.trimEnd('/'))
            .putString("token", encrypt(token))
            .putString("device_name", identity.deviceName)
            .putStringSet("allowed_modes", identity.allowedModes)
            .putBoolean("terminal_enabled", identity.terminalEnabled)
            .commit()) { "Unable to store the managed-device credential" }
    }

    fun clear() {
        preferences.edit().clear().apply()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val payload = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(payload, Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String {
        val payload = Base64.decode(value, Base64.NO_WRAP)
        require(payload.size > IV_BYTES)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, payload.copyOfRange(0, IV_BYTES)))
        return String(cipher.doFinal(payload.copyOfRange(IV_BYTES, payload.size)), Charsets.UTF_8)
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build())
        return generator.generateKey()
    }

    companion object {
        private const val KEY_ALIAS = "makerspace_managed_device_v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
    }
}
