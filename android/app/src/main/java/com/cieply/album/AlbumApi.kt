package com.cieply.album

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** The album said no, or could not be understood. The message is written to be shown as it is. */
class AlbumException(message: String, val status: Int = 0) : IOException(message)

data class UploadResult(val photoId: String, val duplicate: Boolean)

/** One item as `/api/photos/status` reports it. */
data class PhotoStatus(
    val id: String,
    val status: String,
    val error: String?,
    val place: LatLng?,
    val gpsSource: String?,
    val takenAt: String?,
)

/** A file the album already holds, found by its hash. */
data class Have(val photoId: String, val mine: Boolean)

/** A trip the member can send to, as `/api/v1/trips` lists it. Dates are calendar days ("2025-08-10"). */
data class Trip(val id: String, val title: String, val startDate: String, val endDate: String)

/** A YouTube link the album has taken. */
data class AddedVideo(val photoId: String, val title: String)

/** A trip or a collection that can be shown as a slideshow. `kind` is "trip" or "collection", as the album's address says it. */
data class Show(val kind: String, val slug: String, val title: String, val detail: String, val items: Int)

/** One page of the album's list of trips or collections, and where the next page starts (null at the end). */
data class ShowPage(val shows: List<Show>, val next: Int?)

/**
 * One picture of a slideshow. `thumb` is for the phone, fetched with its sign-in; `cast` is the address a television
 * fetches by itself, signed by the album and good for a few hours.
 */
data class Slide(val id: String, val title: String?, val caption: String?, val day: String?, val place: String?, val thumb: String, val cast: String)

data class SlideShow(val title: String, val slides: List<Slide>)

/** The album's answers, read. Kept apart from the network so they are tested on the build machine. */
object AlbumJson {
    fun member(body: String): Member {
        val root = JSONObject(body)
        val user = root.getJSONObject("user")
        val limits = root.getJSONObject("limits")
        return Member(
            email = user.getString("email"),
            name = user.optString("name").takeIf { it.isNotBlank() && !user.isNull("name") },
            limits = Limits(
                photoBytes = limits.getLong("photoBytes"),
                videoBytes = limits.getLong("videoBytes"),
                clipSeconds = limits.getInt("clipSeconds"),
                imageTypes = strings(limits.getJSONArray("imageTypes")),
                videoTypes = strings(limits.getJSONArray("videoTypes")),
            ),
        )
    }

    fun upload(body: String): UploadResult {
        val root = JSONObject(body)
        return UploadResult(root.getString("photoId"), root.optBoolean("duplicate", false))
    }

    fun status(body: String, id: String): PhotoStatus? {
        val photos = JSONObject(body).getJSONArray("photos")
        for (i in 0 until photos.length()) {
            val p = photos.getJSONObject(i)
            if (p.getString("id") != id) continue
            val place = if (p.isNull("lat") || p.isNull("lng")) null else LatLng(p.getDouble("lat"), p.getDouble("lng"))
            return PhotoStatus(
                id = id,
                status = p.getString("status"),
                error = if (p.isNull("error")) null else p.getString("error"),
                place = place,
                gpsSource = if (p.isNull("gpsSource")) null else p.getString("gpsSource"),
                takenAt = if (p.isNull("takenAt")) null else p.getString("takenAt"),
            )
        }
        return null
    }

    /** The answer to "do you have this file?": null when the album does not. */
    fun have(body: String): Have? {
        val root = JSONObject(body)
        if (root.isNull("have")) return null
        val have = root.getJSONObject("have")
        return Have(have.getString("id"), have.optBoolean("mine", false))
    }

    fun trips(body: String): List<Trip> {
        val array = JSONObject(body).getJSONArray("trips")
        return (0 until array.length()).map {
            val t = array.getJSONObject(it)
            Trip(t.getString("id"), t.getString("title"), t.optString("startDate"), t.optString("endDate"))
        }
    }

    private fun text(o: JSONObject, key: String): String? = if (o.isNull(key)) null else o.optString(key).takeIf { it.isNotBlank() }

    /** A page of `/api/v1/album/trips` or `/api/v1/album/collections`; `kind` says which. */
    fun shows(body: String, kind: String): ShowPage {
        val root = JSONObject(body)
        val array = root.getJSONArray(if (kind == "trip") "trips" else "collections")
        val shows = (0 until array.length()).map {
            val o = array.getJSONObject(it)
            val detail = if (kind == "trip") Helpers.tripDays(o.optString("startDate"), o.optString("endDate")) else ""
            Show(kind, o.getString("slug"), o.getString("title"), detail, o.optInt("items", 0))
        }
        return ShowPage(shows, if (root.isNull("next")) null else root.optInt("next"))
    }

    fun slideShow(body: String): SlideShow {
        val root = JSONObject(body)
        val array = root.getJSONArray("slides")
        return SlideShow(
            root.optString("title"),
            (0 until array.length()).map {
                val o = array.getJSONObject(it)
                Slide(o.getString("id"), text(o, "title"), text(o, "caption"), text(o, "day"), text(o, "place"), o.getString("thumb"), o.getString("cast"))
            },
        )
    }

    fun addedVideo(body: String): AddedVideo {
        val root = JSONObject(body)
        return AddedVideo(root.getString("photoId"), root.optString("title"))
    }

    /** What is sent to add a YouTube link: the link, the day the video is from, and the trip if one was chosen. */
    fun videoRequest(url: String, day: String, tripId: String?): String =
        JSONObject().put("url", url.trim()).put("date", day).put("tripId", tripId ?: JSONObject.NULL).toString()

    /** The album's own words for what went wrong, when it sent any. */
    fun error(body: String?): String? = try {
        JSONObject(body ?: "").optString("error").takeIf { it.isNotBlank() }
    } catch (e: Exception) {
        null
    }

    private fun strings(array: JSONArray): Set<String> = (0 until array.length()).map { array.getString(it) }.toSet()
}

/** Talks to one album as one member. Every call blocks, so call from a background dispatcher. */
class AlbumApi(private val baseUrl: String, private val token: String) {
    private fun request(path: String): Request.Builder =
        Request.Builder().url("$baseUrl$path").header("Authorization", "Bearer $token").header("Accept", "application/json")

    private fun send(request: Request): String {
        client.newCall(request).execute().use { response ->
            val body = response.body?.string()
            if (response.isSuccessful && body != null) return body
            val said = AlbumJson.error(body)
            throw AlbumException(
                when {
                    response.code == 401 -> "The album did not accept this sign-in. The token may be mistyped, revoked, or unused for too long."
                    said != null -> said
                    else -> "The album answered with an error (${response.code})."
                },
                response.code,
            )
        }
    }

    fun me(): Member = try {
        AlbumJson.member(send(request("/api/v1/me").get().build()))
    } catch (e: org.json.JSONException) {
        throw AlbumException("That address answered, but not like the album does. Check the address.")
    }

    /** Sends the file exactly as it is: the body is the file's own bytes, and what describes it rides in headers. */
    fun upload(open: () -> InputStream, fileName: String, mime: String, bytes: Long?, lastModifiedMs: Long?, attempt: Int = 1, tripId: String? = null): UploadResult {
        val body = object : RequestBody() {
            override fun contentType() = mime.toMediaTypeOrNull()
            override fun contentLength() = bytes ?: -1L
            override fun isOneShot() = false
            override fun writeTo(sink: BufferedSink) {
                open().use { input -> sink.writeAll(input.source()) }
            }
        }
        val builder = request("/api/upload").post(body)
            .header("x-file-name", Helpers.encodeFileName(fileName))
            .header("x-upload-attempt", attempt.coerceAtLeast(1).toString())
        if (lastModifiedMs != null) builder.header("x-last-modified", lastModifiedMs.toString())
        // Left out, the album files it by the date it was taken.
        if (tripId != null) builder.header("x-trip-id", tripId)
        return AlbumJson.upload(send(builder.build()))
    }

    /** Asks whether the album already holds the file with this SHA-256, so it need not be sent to find out. */
    fun have(sha256: String): Have? = AlbumJson.have(send(request("/api/photos/status?sha256=$sha256").get().build()))

    /** The trips to choose from, newest first. */
    fun trips(): List<Trip> = try {
        AlbumJson.trips(send(request("/api/v1/trips").get().build()))
    } catch (e: org.json.JSONException) {
        throw AlbumException("The album's list of trips could not be read.")
    }

    /** Adds a YouTube link to the album: what stands in for a video too big or too long to keep there. */
    fun addVideo(url: String, day: String, tripId: String?): AddedVideo = try {
        AlbumJson.addedVideo(
            send(request("/api/v1/videos").post(AlbumJson.videoRequest(url, day, tripId).toRequestBody("application/json".toMediaTypeOrNull())).build()),
        )
    } catch (e: org.json.JSONException) {
        throw AlbumException("The album answered, but not in a way the app could read.")
    }

    /** Every trip or every collection in the album, a page at a time until there are no more. */
    fun shows(kind: String): List<Show> = try {
        val all = ArrayList<Show>()
        var from: Int? = 0
        // A stop well past any family's album, so an answer that never ends cannot keep the phone asking for ever.
        while (from != null && all.size < 5000) {
            val page = AlbumJson.shows(send(request("/api/v1/album/${if (kind == "trip") "trips" else "collections"}?from=$from").get().build()), kind)
            all.addAll(page.shows)
            from = if (page.shows.isEmpty()) null else page.next
        }
        all
    } catch (e: org.json.JSONException) {
        throw AlbumException("The album's list could not be read.")
    }

    /** A trip's or a collection's slideshow, with the addresses a television can fetch. */
    fun slideShow(kind: String, slug: String): SlideShow = try {
        AlbumJson.slideShow(send(request("/api/v1/album/slideshow?$kind=${Helpers.encodeFileName(slug)}").get().build()))
    } catch (e: org.json.JSONException) {
        throw AlbumException("The album's slideshow could not be read.")
    }

    /** A picture's bytes from one of the album's own paths, as this member. */
    fun bytes(path: String): ByteArray {
        client.newCall(request(path).get().build()).execute().use { response ->
            val body = response.body?.bytes()
            if (!response.isSuccessful || body == null) throw AlbumException("The album would not give that picture (${response.code}).", response.code)
            return body
        }
    }

    fun status(id: String): PhotoStatus? = AlbumJson.status(send(request("/api/photos/status?ids=$id").get().build()), id)

    companion object {
        /**
         * The last step of signing in: the code the website handed back, with the secret only this app holds, for
         * this phone's token. Nobody is signed in yet, so it carries no Authorization header.
         */
        fun exchange(baseUrl: String, code: String, verifier: String): String {
            val json = JSONObject().put("code", code).put("verifier", verifier).toString()
            val request = Request.Builder().url("$baseUrl/api/v1/phone-link")
                .post(json.toRequestBody("application/json".toMediaTypeOrNull()))
                .header("Accept", "application/json").build()
            client.newCall(request).execute().use { response ->
                val body = response.body?.string()
                if (!response.isSuccessful || body == null) {
                    throw AlbumException(AlbumJson.error(body) ?: "The album answered with an error (${response.code}).", response.code)
                }
                return try {
                    JSONObject(body).getString("token")
                } catch (e: org.json.JSONException) {
                    throw AlbumException("That address answered, but not like the album does.")
                }
            }
        }

        // One client for the app. No read timeout shorter than a slow phone upload of a clip would need.
        private val client: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .followRedirects(false)
            .build()
    }
}
