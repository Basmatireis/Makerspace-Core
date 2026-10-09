package at.makerspace.core.terminal

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

class CoreRegistrationClientTest {
    @Test
    fun sendsNativeCredentialWithoutBrowserOriginAndReturnsServerIdentity() {
        val token = "a".repeat(43)
        lateinit var connection: FakeConnection
        val client = CoreRegistrationClient { url ->
            FakeConnection(url, HttpURLConnection.HTTP_OK, SUCCESS_RESPONSE).also { connection = it }
        }

        val identity = client.report("http://localhost:5173/", token, listOf(
            HardwareCapability("nfc", available = true, state = "ready"),
            HardwareCapability("camera", available = true, state = "simulated"),
            HardwareCapability("qr", available = false, state = "disconnected"),
        ))

        assertEquals("PUT", connection.requestMethod)
        assertEquals("/api/v1/managed-devices/self/hardware", connection.url.path)
        assertEquals(token, connection.getRequestProperty("X-Managed-Device-Token"))
        assertNull(connection.getRequestProperty("Origin"))
        val request = JSONObject(connection.requestBody.toString(Charsets.UTF_8.name()))
        assertEquals("android", request.getString("platform"))
        assertEquals(listOf("nfc"), request.getJSONArray("capabilities").let { values ->
            (0 until values.length()).map(values::getString)
        })
        assertEquals("0199d263-cba8-7c06-98ff-244776840e79", identity.deviceId)
        assertEquals("Entrance terminal", identity.deviceName)
        assertEquals(setOf("visitor_terminal", "staff_ui"), identity.allowedModes)
        assertTrue(identity.terminalEnabled)
    }

    @Test
    fun preservesStructuredRejectionWithoutExposingServerBodyOrCredential() {
        val token = "b".repeat(43)
        val client = CoreRegistrationClient { url ->
            FakeConnection(
                url,
                HttpURLConnection.HTTP_FORBIDDEN,
                errorBody = """{"code":"origin_invalid","message":"request rejected $token"}""",
            )
        }

        val rejection = try {
            client.report("http://localhost:5173", token, emptyList())
            fail("expected registration rejection")
            throw AssertionError("unreachable")
        } catch (error: RegistrationRejectedException) {
            error
        }

        assertEquals(HttpURLConnection.HTTP_FORBIDDEN, rejection.status)
        assertEquals("origin_invalid", rejection.code)
        assertFalse(rejection.message.orEmpty().contains(token))
        val userMessage = registrationErrorMessage(rejection)
        assertTrue(userMessage.contains("native hardware request"))
        assertFalse(userMessage.contains(token))
        assertFalse(userMessage.contains("request rejected"))
    }

    @Test
    fun explainsInvalidOrRevokedCredential() {
        val unauthorized = RegistrationRejectedException(HttpURLConnection.HTTP_UNAUTHORIZED, "unauthenticated")
        val message = registrationErrorMessage(unauthorized)
        assertTrue(message.contains("invalid, expired, or revoked"))
        assertTrue(message.contains("Rotate the device token"))
        assertTrue(shouldClearStoredRegistration(unauthorized))
        assertFalse(shouldClearStoredRegistration(RegistrationRejectedException(HttpURLConnection.HTTP_FORBIDDEN, "origin_invalid")))
    }

    private class FakeConnection(
        url: URL,
        private val status: Int,
        responseBody: String = "",
        errorBody: String = "",
    ) : HttpURLConnection(url) {
        val requestBody = ByteArrayOutputStream()
        private val response = responseBody.toByteArray(Charsets.UTF_8)
        private val error = errorBody.toByteArray(Charsets.UTF_8)

        override fun connect() = Unit
        override fun disconnect() = Unit
        override fun usingProxy(): Boolean = false
        override fun getOutputStream() = requestBody
        override fun getResponseCode(): Int = status
        override fun getInputStream(): InputStream = ByteArrayInputStream(response)
        override fun getErrorStream(): InputStream = ByteArrayInputStream(error)
    }

    private companion object {
        const val SUCCESS_RESPONSE = """
            {
              "deviceId":"0199d263-cba8-7c06-98ff-244776840e79",
              "deviceName":"Entrance terminal",
              "allowedApplicationModes":["visitor_terminal","staff_ui"],
              "terminalEnabled":true
            }
        """
    }
}
