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

    @Test
    fun `a video too big or too long is one for YouTube, and nothing else is`() {
        assertEquals(true, Helpers.needsYouTube("video/mp4", 200L shl 20, 91_000, limits))
        assertEquals(true, Helpers.needsYouTube("video/mp4", 2L shl 30, null, limits))
        assertEquals(false, Helpers.needsYouTube("video/mp4", 200L shl 20, 60_000, limits))
        assertEquals(false, Helpers.needsYouTube("image/jpeg", 101L shl 20, null, limits))
        assertEquals(false, Helpers.needsYouTube("video/x-unknown", 2L shl 30, null, limits))
        assertEquals(false, Helpers.needsYouTube(null, 2L shl 30, null, limits))
    }

    @Test
    fun `a moment is the day it fell on where the phone is`() {
        // 03:30 UTC on the 13th is still the evening of the 12th in Washington.
        val ms = java.time.Instant.parse("2025-08-13T03:30:00Z").toEpochMilli()
        assertEquals("2025-08-12", Helpers.dayString(ms, java.time.ZoneId.of("America/New_York")))
        assertEquals("2025-08-13", Helpers.dayString(ms, java.time.ZoneId.of("UTC")))
    }

    @Test
    fun `a trip's days are written in a line`() {
        assertEquals("10 to 16 August 2025", Helpers.tripDays("2025-08-10", "2025-08-16"))
        assertEquals("30 July to 2 August 2025", Helpers.tripDays("2025-07-30", "2025-08-02"))
        assertEquals("28 December 2025 to 3 January 2026", Helpers.tripDays("2025-12-28", "2026-01-03"))
        assertEquals("4 July 2025", Helpers.tripDays("2025-07-04", "2025-07-04"))
        assertEquals("", Helpers.tripDays("", "nonsense"))
    }

    @Test
    fun `the notification says what is left and how it ended`() {
        assertEquals("1 left to send", Helpers.progressLine(1))
        assertEquals("7 left to send", Helpers.progressLine(7))
        assertEquals("12 in the album", Helpers.finishedLine(12, 0, 0))
        assertEquals("12 in the album, 1 not sent, 1 video is too big and needs YouTube", Helpers.finishedLine(12, 1, 1))
        assertEquals("2 videos are too big and need YouTube", Helpers.finishedLine(0, 0, 2))
        assertEquals("Nothing left to send", Helpers.finishedLine(0, 0, 0))
        assertEquals("1 waiting to send, 2 for YouTube", Helpers.queueSummary(1, 0, 0, 2))
    }

    private fun slide(id: String, dayKey: String?) = Slide(id, null, null, null, null, "/t/$id", "/c/$id", dayKey)

    @Test
    fun `a slideshow is asked for with whatever it is narrowed by`() {
        assertEquals("trip=maine%202025", Helpers.showQuery("trip", "maine 2025", ShowFilter()))
        assertEquals(
            "collection=best&q=light%20house&uploader=u1&person=a&person=b&activity=act&year=2019",
            Helpers.showQuery("collection", "best", ShowFilter(" light house ", "u1", setOf("b", "a"), "act", 2019)),
        )
        assertEquals("all=1&person=a", Helpers.showQuery(Helpers.ALL, "", ShowFilter(personIds = setOf("a"))))
    }

    @Test
    fun `slides are laid out by day in order with the undated last`() {
        val days = Helpers.slideDays(listOf(slide("b", "2025-08-12"), slide("x", null), slide("a", "2025-08-11"), slide("c", "2025-08-12")))
        assertEquals(listOf("2025-08-11", "2025-08-12", Helpers.UNDATED), days.map { it.key })
        assertEquals(listOf("Mon, Aug 11", "Tue, Aug 12", "No date"), days.map { it.label })
        assertEquals(listOf("b", "c"), days[1].slides.map { it.id })
    }

    @Test
    fun `days say their year only when there is more than one`() {
        val days = Helpers.slideDays(listOf(slide("a", "2024-12-31"), slide("b", "2025-01-01")))
        assertEquals(listOf("Tue, Dec 31, 2024", "Wed, Jan 1, 2025"), days.map { it.label })
    }

    @Test
    fun `an arranged collection is one run in its own order`() {
        val days = Helpers.slideDays(listOf(slide("b", "2025-08-12"), slide("a", "2025-08-11")), arranged = true)
        assertEquals(1, days.size)
        assertEquals("", days[0].label)
        assertEquals(listOf("b", "a"), days[0].slides.map { it.id })
        assertEquals(emptyList<SlideDay>(), Helpers.slideDays(emptyList(), arranged = true))
    }

    @Test
    fun `picking days keeps only those and picking none keeps all`() {
        val days = Helpers.slideDays(listOf(slide("a", "2025-08-11"), slide("b", "2025-08-12"), slide("c", "2025-08-13")))
        assertEquals(days, Helpers.pickedDays(days, emptySet()))
        assertEquals(listOf("2025-08-11", "2025-08-13"), Helpers.pickedDays(days, setOf("2025-08-13", "2025-08-11")).map { it.key })
        assertEquals(days, Helpers.pickedDays(days, setOf("2001-01-01")))
    }

    @Test
    fun `next and previous go round and start the list when the photo on the television is not in it`() {
        val slides = listOf(slide("a", null), slide("b", null), slide("c", null))
        assertEquals("b", Helpers.step(slides, "a", 1)?.id)
        assertEquals("a", Helpers.step(slides, "c", 1)?.id)
        assertEquals("c", Helpers.step(slides, "a", -1)?.id)
        assertEquals("a", Helpers.step(slides, "gone", 1)?.id)
        assertEquals("c", Helpers.step(slides, "gone", -1)?.id)
        assertEquals("a", Helpers.step(slides, null, 1)?.id)
        assertEquals(null, Helpers.step(emptyList(), "a", 1))
    }

    @Test
    fun `the count says how much of the show is left`() {
        assertEquals("340 photos", Helpers.shownLine(340, 340))
        assertEquals("1 photo", Helpers.shownLine(1, 1))
        assertEquals("12 of 340 photos", Helpers.shownLine(12, 340))
        assertEquals("Nothing matches", Helpers.shownLine(0, 340))
    }

    @Test
    fun `the speed goes round its choices and starts over from anything else`() {
        assertEquals(20, Helpers.nextPace(10))
        assertEquals(5, Helpers.nextPace(30))
        assertEquals(5, Helpers.nextPace(7))
    }

    @Test
    fun `shuffle keeps every photo once and gives the same order for the same seed`() {
        val slides = (1..40).map { slide("p$it", null) }
        val mixed = Helpers.shuffled(slides, 7L)
        assertEquals(slides.map { it.id }.sorted(), mixed.map { it.id }.sorted())
        assertEquals(mixed, Helpers.shuffled(slides, 7L))
        assertEquals(false, mixed == slides)
        assertEquals(false, mixed == Helpers.shuffled(slides, 8L))
        assertEquals(emptyList<Slide>(), Helpers.shuffled(emptyList(), 7L))
    }

    @Test
    fun `the slideshow notification says where it is and whether it is playing`() {
        assertEquals("Photo 3 of 40 · playing, every 10 seconds", Helpers.showLine(2, 40, true, 10, false))
        assertEquals("Photo 1 of 40 · paused · shuffled", Helpers.showLine(0, 40, false, 10, true))
        assertEquals("40 photos · paused", Helpers.showLine(-1, 40, false, 10, false))
        assertEquals("Slideshow · paused", Helpers.showLine(-1, 0, false, 10, false))
    }

    @Test
    fun `the remote names the song the television says is on`() {
        val songs = listOf(Song("a", "Summer Wind", "/api/music/a?cast=1.x"), Song("b", "Moon River", "/api/music/b?cast=1.x"))
        assertEquals("No music playing.", Helpers.musicLine(emptyList(), null, null))
        assertEquals("Music: Summer Wind", Helpers.musicLine(songs, null, null))
        assertEquals("Music: Moon River", Helpers.musicLine(songs, 1, true))
        assertEquals("Music paused: Moon River", Helpers.musicLine(songs, 1, false))
        assertEquals("Music: 2 songs chosen.", Helpers.musicLine(songs, -1, false))
    }

    @Test
    fun `the album's songs are read from what it sends`() {
        val songs = AlbumJson.songs("""{"songs":[{"id":"a","title":"Summer Wind","cast":"/api/music/a?cast=1.x"},{"id":"b","title":"","cast":"/api/music/b?cast=1.x"}]}""")
        assertEquals(listOf(Song("a", "Summer Wind", "/api/music/a?cast=1.x"), Song("b", "Untitled", "/api/music/b?cast=1.x")), songs)
    }

    @Test
    fun `a clip is waited out and a photo stays for the pace chosen`() {
        val photo = slide("a", "2025-08-11")
        assertEquals(10_000L, Helpers.waitMs(photo, 10))
        assertEquals(10_000L, Helpers.waitMs(null, 10))
        assertEquals(20_500L, Helpers.waitMs(photo.copy(video = "/v", seconds = 12.5), 10))
        assertEquals(98_000L, Helpers.waitMs(photo.copy(video = "/v"), 10))
        assertEquals(908_000L, Helpers.waitMs(photo.copy(video = "/v", seconds = 5000.0), 10))
    }

    @Test
    fun `a new day is announced once`() {
        val first = slide("a", "2025-08-11").copy(day = "Monday, August 11, 2025")
        assertEquals("Monday, August 11, 2025", Helpers.dayCard(first, null))
        assertEquals(null, Helpers.dayCard(first, "2025-08-11"))
        assertEquals("Monday, August 11, 2025", Helpers.dayCard(first, "2025-08-10"))
        assertEquals(null, Helpers.dayCard(slide("b", null), "2025-08-10"))
    }

    @Test
    fun `clips are asked for only when the television can play them`() {
        assertEquals("trip=coast", Helpers.showQuery("trip", "coast", ShowFilter()))
        assertEquals("trip=coast&clips=1", Helpers.showQuery("trip", "coast", ShowFilter(), true))
    }
}
