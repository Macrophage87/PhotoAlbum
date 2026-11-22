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
}
