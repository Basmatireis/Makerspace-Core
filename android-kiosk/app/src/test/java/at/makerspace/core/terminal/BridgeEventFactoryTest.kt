package at.makerspace.core.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeEventFactoryTest {
    @Test
    fun normalizesNfcAndMarksDuplicateUntilRemoval() {
        val factory = BridgeEventFactory()
        val first = factory.scan(NfcReading("04:a7-31", "simulator"), 1_000)
        val second = factory.scan(NfcReading("04A731", "simulator"), 1_500)
        assertEquals("04A731", first.getJSONObject("nfc").getString("uid"))
        assertFalse(first.getBoolean("duplicate"))
        assertTrue(second.getBoolean("duplicate"))
        factory.removed("simulator", 1_600)
        assertFalse(factory.scan(NfcReading("04A731", "simulator"), 1_700).getBoolean("duplicate"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsMalformedNfcIdentifiers() {
        BridgeEventFactory.normalizeUID("not-a-tag")
    }
}
