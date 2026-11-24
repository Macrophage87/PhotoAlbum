package com.cieply.album

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AlbumJsonTest {
    @Test
    fun `the member and the limits are read`() {
        val member = AlbumJson.member(
            """{"user":{"id":"u1","email":"a@example.com","name":null,"role":"MEMBER"},
               "limits":{"photoBytes":104857600,"videoBytes":1073741824,"clipSeconds":90,
               "imageTypes":["image/jpeg"],"videoTypes":["video/mp4","video/quicktime"]}}""",
        )
        assertEquals("a@example.com", member.email)
        assertNull(member.name)
        assertEquals(1073741824L, member.limits.videoBytes)
        assertEquals(setOf("video/mp4", "video/quicktime"), member.limits.videoTypes)
    }

    @Test
    fun `an upload answer says which item and whether the album had it`() {
        assertEquals(UploadResult("p1", false), AlbumJson.upload("""{"photoId":"p1"}"""))
        assertEquals(UploadResult("p2", true), AlbumJson.upload("""{"photoId":"p2","duplicate":true,"status":"READY"}"""))
    }

    @Test
    fun `the album says whether it already holds a file`() {
        assertNull(AlbumJson.have("""{"have":null}"""))
        assertEquals(Have("p7", false), AlbumJson.have("""{"have":{"id":"p7","status":"READY","mine":false}}"""))
        assertEquals(Have("p8", true), AlbumJson.have("""{"have":{"id":"p8","status":"PENDING","mine":true}}"""))
    }

    @Test
    fun `a status answer carries where the album put it`() {
        val body = """{"photos":[
            {"id":"p0","status":"PENDING","error":null,"lat":null,"lng":null,"gpsSource":null,"takenAt":null},
            {"id":"p1","status":"READY","error":null,"lat":38.8977,"lng":-77.0365,"gpsSource":"EXIF","takenAt":"2026-11-01T12:00:00.000Z"}]}"""
        val ready = AlbumJson.status(body, "p1")!!
        assertEquals("READY", ready.status)
        assertEquals(LatLng(38.8977, -77.0365), ready.place)
        assertEquals("EXIF", ready.gpsSource)
        val pending = AlbumJson.status(body, "p0")!!
        assertNull(pending.place)
        assertNull(pending.gpsSource)
        assertNull(AlbumJson.status(body, "nope"))
    }

    @Test
    fun `the album's own words for an error are used when it sent any`() {
        assertEquals("File is larger than 100 MB", AlbumJson.error("""{"error":"File is larger than 100 MB"}"""))
        assertNull(AlbumJson.error("<html>502</html>"))
        assertNull(AlbumJson.error(null))
    }

    @Test
    fun `the album's trips are read in the order it gives them`() {
        val body = """{"trips":[{"id":"t2","slug":"shore","title":"The shore","startDate":"2025-07-01","endDate":"2025-07-04"},{"id":"t1","slug":"acadia","title":"Acadia","startDate":"2024-08-10","endDate":"2024-08-16"}]}"""
        assertEquals(
            listOf(Trip("t2", "The shore", "2025-07-01", "2025-07-04"), Trip("t1", "Acadia", "2024-08-10", "2024-08-16")),
            AlbumJson.trips(body),
        )
        assertEquals(emptyList<Trip>(), AlbumJson.trips("""{"trips":[]}"""))
    }

    @Test
    fun `a YouTube link is sent with its day and its trip, and the answer read`() {
        val sent = org.json.JSONObject(AlbumJson.videoRequest("  https://youtu.be/dQw4w9WgXcQ ", "2025-08-12", "t1"))
        assertEquals("https://youtu.be/dQw4w9WgXcQ", sent.getString("url"))
        assertEquals("2025-08-12", sent.getString("date"))
        assertEquals("t1", sent.getString("tripId"))
        assertEquals(true, org.json.JSONObject(AlbumJson.videoRequest("x", "2025-08-12", null)).isNull("tripId"))
        assertEquals(AddedVideo("p1", "Falls"), AlbumJson.addedVideo("""{"photoId":"p1","title":"Falls"}"""))
    }

    @Test
    fun `the album's trips and collections are read as things to show, a page at a time`() {
        val trips = AlbumJson.shows("""{"trips":[{"id":"t1","slug":"coast","title":"Coast","startDate":"2025-08-10","endDate":"2025-08-16","items":42}],"total":101,"next":100}""", "trip")
        assertEquals(ShowPage(listOf(Show("trip", "coast", "Coast", "10 to 16 August 2025", 42)), 100), trips)
        val collections = AlbumJson.shows("""{"collections":[{"id":"c1","slug":"best","title":"Best","items":1}],"total":1,"next":null}""", "collection")
        assertEquals(ShowPage(listOf(Show("collection", "best", "Best", "", 1)), null), collections)
    }

    @Test
    fun `a slideshow is read with the address for the phone and the one for the television`() {
        val body = """{"title":"Coast","expiresAt":"2026-11-23T22:00:00.000Z","slides":[
            {"id":"p1","title":null,"caption":"Low tide","day":"Monday, August 11, 2025","place":null,"thumb":"/api/photos/p1/thumb?v=2","cast":"/api/photos/p1/preview?v=2&cast=1.x"},
            {"id":"p2","title":"Harbour","caption":"","day":null,"place":"Bar Harbor","thumb":"/api/photos/p2/thumb?v=1","cast":"/api/photos/p2/preview?v=1&cast=1.y"}]}"""
        val show = AlbumJson.slideShow(body)
        assertEquals("Coast", show.title)
        assertEquals(Slide("p1", null, "Low tide", "Monday, August 11, 2025", null, "/api/photos/p1/thumb?v=2", "/api/photos/p1/preview?v=2&cast=1.x"), show.slides[0])
        assertEquals(Slide("p2", "Harbour", null, null, "Bar Harbor", "/api/photos/p2/thumb?v=1", "/api/photos/p2/preview?v=1&cast=1.y"), show.slides[1])
    }

    @Test
    fun `a slideshow says each day and what it can be narrowed by`() {
        val body = """{"title":"Coast","total":9,"arranged":true,"choices":{
            "members":[{"id":"u1","label":"Pat"}],
            "people":[{"id":"a","name":"Ada","kind":"HUMAN"},{"id":"b","name":"Biscuit","kind":"PET"}],
            "activities":[{"id":"w","label":"Harbour walk"}]},
            "slides":[{"id":"p1","title":null,"caption":null,"day":"Monday, August 11, 2025","dayKey":"2025-08-11","place":null,"thumb":"/t","cast":"/c"},
                      {"id":"p2","title":null,"caption":null,"day":null,"dayKey":null,"place":null,"thumb":"/t","cast":"/c"}]}"""
        val show = AlbumJson.slideShow(body)
        assertEquals(9, show.total)
        assertEquals(true, show.arranged)
        assertEquals(listOf("2025-08-11", null), show.slides.map { it.dayKey })
        assertEquals(SlideChoices(listOf(Choice("u1", "Pat")), listOf(Choice("a", "Ada")), listOf(Choice("b", "Biscuit")), listOf(Choice("w", "Harbour walk"))), show.choices)
    }

    @Test
    fun `an older album's slideshow still reads, with nothing to narrow by`() {
        val show = AlbumJson.slideShow("""{"title":"Coast","slides":[{"id":"p1","thumb":"/t","cast":"/c"}]}""")
        assertEquals(1, show.total)
        assertEquals(false, show.arranged)
        assertEquals(SlideChoices(), show.choices)
    }

    @Test
    fun `a slide says who is in it, where it was and whether it is a clip`() {
        val show = AlbumJson.slideShow(
            """{"title":"Coast","slides":[
            {"id":"p1","title":null,"caption":null,"day":null,"dayKey":null,"place":null,"thumb":"/t","cast":"/c","people":["Ada","Biscuit"],"lat":38.9,"lng":-77.03,"video":null,"seconds":null},
            {"id":"v1","title":"Waves","caption":null,"day":null,"dayKey":null,"place":null,"thumb":"/t2","cast":"/c2","people":[],"lat":null,"lng":null,"video":"/api/photos/v1/video?v=1&cast=1.x","seconds":12.5}]}""",
        )
        assertEquals(listOf("Ada", "Biscuit"), show.slides[0].people)
        assertEquals(38.9, show.slides[0].lat!!, 0.0001)
        assertEquals(-77.03, show.slides[0].lng!!, 0.0001)
        assertNull(show.slides[0].video)
        assertEquals("/api/photos/v1/video?v=1&cast=1.x", show.slides[1].video)
        assertEquals(12.5, show.slides[1].seconds!!, 0.0001)
        assertNull(show.slides[1].lat)
    }
}
