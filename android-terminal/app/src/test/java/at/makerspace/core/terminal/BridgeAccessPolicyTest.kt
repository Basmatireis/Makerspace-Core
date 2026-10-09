package at.makerspace.core.terminal

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeAccessPolicyTest {
    @Test
    fun allowsOnlyTheExactConfiguredOrigin() {
        val policy = BridgeAccessPolicy.fromCoreURL("https://core.example.org/base", allowDebugHTTP = false)
        assertTrue(policy.permitsNavigation("https://core.example.org/terminal"))
        assertFalse(policy.permitsNavigation("https://evil.example/"))
        assertFalse(policy.permitsNavigation("https://core.example.org.evil.example/"))
        assertFalse(policy.permitsNavigation("http://core.example.org/"))
        assertFalse(policy.permitsNavigation("https://core.example.org:444/"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsCleartextProductionOrigins() {
        BridgeAccessPolicy.fromCoreURL("http://10.0.2.2:8080", allowDebugHTTP = false)
    }

    @Test
    fun allowsOnlyKnownEmulatorCleartextInDebug() {
        assertTrue(BridgeAccessPolicy.fromCoreURL("http://10.0.2.2:8080", allowDebugHTTP = true).permitsNavigation("http://10.0.2.2:8080/terminal"))
        runCatching { BridgeAccessPolicy.fromCoreURL("http://192.168.1.10:8080", allowDebugHTTP = true) }
            .onSuccess { throw AssertionError("LAN cleartext URL was accepted") }
    }
}
