package com.cieply.album

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HelpersTest {
    private val limits = Limits(
        photoBytes = 100L shl 20,
        videoBytes = 1L shl 30,
        clipSeconds = 90,
        imageTypes = setOf("image/jpeg", "image/heic"),
        videoTypes = setOf("video/mp4"),
    )

    @Test
    fun `an address is made into an https origin however it was typed`() {
        assertEquals("https://album.example.com", Helpers.normalizeBaseUrl("album.example.com"))
        assertEquals("https://album.example.com", Helpers.normalizeBaseUrl("  https://Album.Example.com/trips/  "))
        assertEquals("https://album.example.com:8443", Helpers.normalizeBaseUrl("https://album.example.com:8443"))
        assertEquals("https://album.example.com", Helpers.normalizeBaseUrl("https://album.example.com:443/"))
    }

    @Test
    fun `plain http and nonsense are refused`() {
        assertNull(Helpers.normalizeBaseUrl("http://album.example.com"))
        assertNull(Helpers.normalizeBaseUrl(""))
        assertNull(Helpers.normalizeBaseUrl("album example com"))
        assertNull(Helpers.normalizeBaseUrl("https://someone@album.example.com"))
    }

    @Test
    fun `a file name is encoded as a browser would for the header`() {
        assertEquals("IMG_0001.jpg", Helpers.encodeFileName("IMG_0001.jpg"))
        assertEquals("Lac%20L%C3%A9man%20%281%29.jpg", Helpers.encodeFileName("Lac Léman (1).jpg"))
        assertEquals("a%2Bb%25.jpg", Helpers.encodeFileName("a+b%.jpg"))
    }

    @Test
    fun `a video location is read with or without an altitude`() {
        assertEquals(LatLng(38.8977, -77.0365), Helpers.parseIso6709("+38.8977-077.0365/"))
        assertEquals(LatLng(-33.8568, 151.2153), Helpers.parseIso6709("-33.8568+151.2153+012.300/"))
        assertNull(Helpers.parseIso6709(null))
        assertNull(Helpers.parseIso6709("+00.0000+000.0000/"))
        assertNull(Helpers.parseIso6709("somewhere"))
        assertNull(Helpers.parseIso6709("+98.0000+000.0000/"))
    }

    @Test
    fun `what the album would refuse is refused before sending`() {
        assertNull(Helpers.refusal("image/jpeg", 5L shl 20, null, limits))
        assertNull(Helpers.refusal("video/mp4", 200L shl 20, 60_000, limits))
        assertEquals(true, Helpers.refusal("image/jpeg", 101L shl 20, null, limits)!!.contains("100.0 MB"))
        assertEquals(true, Helpers.refusal("video/mp4", 200L shl 20, 91_000, limits)!!.contains("YouTube"))
        assertEquals(true, Helpers.refusal("application/pdf", 1, null, limits)!!.contains("application/pdf"))
        assertEquals(true, Helpers.refusal(null, 1, null, limits) != null)
    }

    @Test
    fun `sizes are written for people`() {
        assertEquals("1 KB", Helpers.formatBytes(1))
        assertEquals("1.5 MB", Helpers.formatBytes(3L shl 19))
        assertEquals("1.0 GB", Helpers.formatBytes(1L shl 30))
    }

    @Test
    fun `asking to sign in sends the hash of a secret, never the secret`() {
        // The example from RFC 7636, which the album's server follows too.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Helpers.challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        val verifier = Helpers.newVerifier()
        assertEquals(43, verifier.length)
        assertEquals(43, Helpers.challengeOf(verifier).length)
        assertEquals(false, verifier == Helpers.newVerifier())
        assertEquals(
            "https://album.example.com/account/phone?challenge=abc&app=familyalbum-debug&name=Pixel%209%20Pro",
            Helpers.connectUrl("https://album.example.com", "abc", "Pixel 9 Pro", "familyalbum-debug"),
        )
    }

    @Test
    fun `the code is read from the link the website hands back`() {
        val code = "A".repeat(43)
        assertEquals(code, Helpers.codeFrom("familyalbum://connect?code=$code"))
        assertEquals(code, Helpers.codeFrom("familyalbum-debug://connect?x=1&code=$code&y=2"))
        assertNull(Helpers.codeFrom("familyalbum://connect?code=short"))
        assertNull(Helpers.codeFrom("familyalbum://elsewhere?code=$code"))
        assertNull(Helpers.codeFrom(null))
    }

    @Test
    fun `a file is told apart by its name, size and when it changed`() {
        assertEquals("IMG_1.jpg|2048|1700000000", Helpers.fileKey("IMG_1.jpg", 2048, 1700000000))
        assertEquals("IMG_1.jpg|?|?", Helpers.fileKey("IMG_1.jpg", null, null))
    }

    @Test
    fun `a digest is written the way the album writes one`() {
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest("abc".toByteArray())
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Helpers.hex(digest))
    }

    @Test
    fun `the queue is summed up in a line`() {
        assertEquals(null, Helpers.queueSummary(0, 0, 0))
        assertEquals("3 waiting to send", Helpers.queueSummary(3, 0, 0))
        assertEquals("3 waiting to send, 12 in the album, 1 not sent", Helpers.queueSummary(3, 12, 1))
    }
}
