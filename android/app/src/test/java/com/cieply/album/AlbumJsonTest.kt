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
}
