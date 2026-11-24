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

/** One of a trip's activities. Its times are the clock's on the trip, to the minute ("2025-08-12T15:04"). */
data class Outing(val id: String, val title: String, val label: String, val start: String, val end: String)

/** A kind an activity can be: the album's word for it, and the name to show. */
data class OutingKind(val type: String, val label: String)

/** A trip's activities, the kinds a new one can be, and whether this member may add one. */
data class TripOutings(val outings: List<Outing>, val kinds: List<OutingKind>, val canAdd: Boolean)

/** A collection photos can be put in, by name. */
data class CollectionName(val id: String, val title: String)

/** Where photos are being put: a trip, one of its activities, a collection, or any of them. */
data class Filing(val trip: Trip? = null, val outing: Outing? = null, val collection: CollectionName? = null) {
    val chosen: Boolean get() = trip != null || outing != null || collection != null
}

/** Something already in the album, for choosing: `mine` says whether this member may move it. */
data class AlbumItem(
    val id: String,
    val thumb: String,
    val day: String?,
    val video: Boolean,
    val mine: Boolean,
    /** For looking at it: a bigger copy, what is written on it, where it was taken, and its page on the website. */
    val medium: String = thumb,
    val title: String? = null,
    val caption: String? = null,
    val place: String? = null,
    val page: String = "",
)

/** One page of a trip's or a collection's items, and what to ask the next page with (null at the end). */
data class ItemPage(val items: List<AlbumItem>, val next: String?)

/** How a filing went: how many are now where they were put, and how many are somebody else's and were left. */
data class Filed(val filed: Int, val notYours: Int)

/** A YouTube link the album has taken. */
data class AddedVideo(val photoId: String, val title: String)

/** A trip or a collection that can be shown as a slideshow. `kind` is "trip" or "collection", as the album's address says it. */
data class Show(
    val kind: String,
    val slug: String,
    val title: String,
    val detail: String,
    val items: Int,
    /** For the browsing screens: the album's id for it, its cover's address, what is written about it, and a trip's days. */
    val id: String = "",
    val cover: String? = null,
    val description: String? = null,
    val startDate: String = "",
    val endDate: String = "",
)

/** One page of the album's list of trips or collections, and where the next page starts (null at the end). */
data class ShowPage(val shows: List<Show>, val next: Int?)

/** A song a member added to the album, with the address a television plays it from for the next few hours. */
data class Song(val id: String, val title: String, val cast: String)

/**
 * One picture of a slideshow. `thumb` is for the phone, fetched with its sign-in; `cast` is the address a television
 * fetches by itself, signed by the album and good for a few hours.
 */
data class Slide(
    val id: String,
    val title: String?,
    val caption: String?,
    val day: String?,
    val place: String?,
    val thumb: String,
    val cast: String,
    /** The day as "2025-08-12", or null when nobody knows it. */
    val dayKey: String? = null,
    /** The people and pets a member has said are in it. */
    val people: List<String> = emptyList(),
    val lat: Double? = null,
    val lng: Double? = null,
    /** For a clip: the address a television plays it from (`cast` is then its still), and its length where known. */
    val video: String? = null,
    val seconds: Double? = null,
)

/** Something a slideshow can be narrowed by: a member, a person or pet, or an outing. */
data class Choice(val id: String, val label: String)

/** What this slideshow can be narrowed by, as the album's own timeline offers it. */
data class SlideChoices(
    val members: List<Choice> = emptyList(),
    val people: List<Choice> = emptyList(),
    val pets: List<Choice> = emptyList(),
    val activities: List<Choice> = emptyList(),
)

/** What somebody has asked a slideshow for. Several people means the photos they are all in. */
data class ShowFilter(
    val words: String = "",
    val uploaderId: String? = null,
    val personIds: Set<String> = emptySet(),
    val activityId: String? = null,
    val year: Int? = null,
) {
    val active: Boolean get() = words.isNotBlank() || uploaderId != null || personIds.isNotEmpty() || activityId != null || year != null
}

data class SlideShow(
    val title: String,
    val slides: List<Slide>,
    /** How many photos it has with nothing asked. */
    val total: Int = slides.size,
    val choices: SlideChoices = SlideChoices(),
    /** Somebody put this collection in order, so it is shown in that order and not by day. */
    val arranged: Boolean = false,
)

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

    private fun tripOf(t: JSONObject) = Trip(t.getString("id"), t.getString("title"), t.optString("startDate"), t.optString("endDate"))

    /** The answer to making a trip. */
    fun trip(body: String): Trip = tripOf(JSONObject(body).getJSONObject("trip"))

    private fun outingOf(o: JSONObject) = Outing(o.getString("id"), o.getString("title"), o.optString("label"), o.optString("start"), o.optString("end"))

    fun outings(body: String): TripOutings {
        val root = JSONObject(body)
        val array = root.getJSONArray("activities")
        val kinds = root.optJSONArray("types") ?: org.json.JSONArray()
        return TripOutings(
            (0 until array.length()).map { outingOf(array.getJSONObject(it)) },
            (0 until kinds.length()).map { kinds.getJSONObject(it).let { k -> OutingKind(k.getString("type"), k.optString("label", k.getString("type"))) } },
            root.optBoolean("canAdd", false),
        )
    }

    /** The answer to making an activity. */
    fun outing(body: String): Outing = outingOf(JSONObject(body).getJSONObject("activity"))

    private fun collectionOf(c: JSONObject) = CollectionName(c.getString("id"), c.getString("title"))

    fun collections(body: String): List<CollectionName> {
        val array = JSONObject(body).getJSONArray("collections")
        return (0 until array.length()).map { collectionOf(array.getJSONObject(it)) }
    }

    /** The answer to making a collection. */
    fun collection(body: String): CollectionName = collectionOf(JSONObject(body).getJSONObject("collection"))

    /** A page of one trip's or one collection's items. A trip's next page is a word, a collection's a number: both are kept as written. */
    fun items(body: String): ItemPage {
        val root = JSONObject(body)
        val array = root.getJSONArray("items")
        return ItemPage(
            (0 until array.length()).map {
                val o = array.getJSONObject(it)
                AlbumItem(
                    o.getString("id"), o.getString("thumb"), text(o, "day"), o.optString("kind") != "PHOTO", o.optBoolean("mine", false),
                    medium = text(o, "medium") ?: o.getString("thumb"),
                    title = text(o, "title"),
                    caption = text(o, "caption"),
                    place = text(o, "place"),
                    page = o.optString("page"),
                )
            },
            if (root.isNull("next")) null else root.get("next").toString(),
        )
    }

    fun filed(body: String): Filed = JSONObject(body).let { Filed(it.optInt("filed", 0), it.optInt("notYours", 0)) }

    fun tripRequest(title: String, startDate: String, endDate: String, timezone: String): String =
        JSONObject().put("title", title.trim()).put("startDate", startDate).put("endDate", endDate).put("timezone", timezone).toString()

    fun outingRequest(title: String, type: String, start: String, end: String): String =
        JSONObject().put("title", title.trim()).put("type", type).put("start", start).put("end", end).toString()

    fun collectionRequest(title: String): String = JSONObject().put("title", title.trim()).toString()

    /** An activity is on one trip, so naming it says the trip too; the trip is sent only without one. */
    fun fileRequest(photoIds: List<String>, tripId: String?, outingId: String?, collectionId: String?): String =
        JSONObject().put("photoIds", org.json.JSONArray(photoIds))
            .put("tripId", if (outingId == null && tripId != null) tripId else JSONObject.NULL)
            .put("activityId", outingId ?: JSONObject.NULL)
            .put("collectionId", collectionId ?: JSONObject.NULL).toString()

    private fun text(o: JSONObject, key: String): String? = if (o.isNull(key)) null else o.optString(key).takeIf { it.isNotBlank() }

    /** A page of `/api/v1/album/trips` or `/api/v1/album/collections`; `kind` says which. */
    fun shows(body: String, kind: String): ShowPage {
        val root = JSONObject(body)
        val array = root.getJSONArray(if (kind == "trip") "trips" else "collections")
        val shows = (0 until array.length()).map {
            val o = array.getJSONObject(it)
            val detail = if (kind == "trip") Helpers.tripDays(o.optString("startDate"), o.optString("endDate")) else ""
            Show(
                kind, o.getString("slug"), o.getString("title"), detail, o.optInt("items", 0),
                id = o.optString("id"),
                cover = o.optJSONObject("cover")?.let { c -> text(c, "thumb") },
                description = text(o, "description"),
                startDate = o.optString("startDate"),
                endDate = o.optString("endDate"),
            )
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
                val people = o.optJSONArray("people")
                Slide(
                    o.getString("id"), text(o, "title"), text(o, "caption"), text(o, "day"), text(o, "place"), o.getString("thumb"), o.getString("cast"), text(o, "dayKey"),
                    people = if (people == null) emptyList() else (0 until people.length()).map { i -> people.optString(i) }.filter { name -> name.isNotBlank() },
                    lat = if (o.isNull("lat")) null else o.optDouble("lat").takeIf { v -> !v.isNaN() },
                    lng = if (o.isNull("lng")) null else o.optDouble("lng").takeIf { v -> !v.isNaN() },
                    video = text(o, "video"),
                    seconds = if (o.isNull("seconds")) null else o.optDouble("seconds").takeIf { v -> !v.isNaN() },
                )
            },
            root.optInt("total", array.length()),
            slideChoices(root.optJSONObject("choices")),
            root.optBoolean("arranged", false),
        )
    }

    fun songs(body: String): List<Song> {
        val array = JSONObject(body).getJSONArray("songs")
        return (0 until array.length()).map {
            val o = array.getJSONObject(it)
            Song(o.getString("id"), o.optString("title").ifBlank { "Untitled" }, o.getString("cast"))
        }
    }

    private fun slideChoices(o: JSONObject?): SlideChoices {
        if (o == null) return SlideChoices()
        fun list(key: String, label: String, keep: (JSONObject) -> Boolean = { true }): List<Choice> {
            val array = o.optJSONArray(key) ?: return emptyList()
            return (0 until array.length()).map { array.getJSONObject(it) }.filter(keep).map { Choice(it.getString("id"), it.optString(label)) }
        }
        return SlideChoices(
            members = list("members", "label"),
            people = list("people", "name") { it.optString("kind") != "PET" },
            pets = list("people", "name") { it.optString("kind") == "PET" },
            activities = list("activities", "label"),
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
    fun upload(open: () -> InputStream, fileName: String, mime: String, bytes: Long?, lastModifiedMs: Long?, attempt: Int = 1, tripId: String? = null, outingId: String? = null, collectionId: String? = null): UploadResult {
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
        // An activity the member chose, and a collection: the album puts it there as it arrives.
        if (outingId != null) builder.header("x-activity-id", outingId)
        if (collectionId != null) builder.header("x-collection-id", collectionId)
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

    private fun post(path: String, json: String): String = send(request(path).post(json.toRequestBody("application/json".toMediaTypeOrNull())).build())

    /** Calls the album and reads its answer; an answer that will not read is said plainly. */
    private fun <T> read(what: String, ask: () -> T): T = try {
        ask()
    } catch (e: org.json.JSONException) {
        throw AlbumException("The album's $what could not be read.")
    }

    /** Makes a trip. Its days are calendar days ("2025-08-10"), in the time zone named. */
    fun createTrip(title: String, startDate: String, endDate: String, timezone: String): Trip =
        read("answer") { AlbumJson.trip(post("/api/v1/trips", AlbumJson.tripRequest(title, startDate, endDate, timezone))) }

    /** A trip's activities, in the order they happened. */
    fun outings(tripId: String): TripOutings = read("list of activities") { AlbumJson.outings(send(request("/api/v1/trips/$tripId/activities").get().build())) }

    /** Makes an activity on a trip. Its times are the clock's on the trip ("2025-08-12T15:04"). */
    fun createOuting(tripId: String, title: String, type: String, start: String, end: String): Outing =
        read("answer") { AlbumJson.outing(post("/api/v1/trips/$tripId/activities", AlbumJson.outingRequest(title, type, start, end))) }

    /** Every collection, by name. */
    fun collections(): List<CollectionName> = read("list of collections") { AlbumJson.collections(send(request("/api/v1/collections").get().build())) }

    fun createCollection(title: String): CollectionName = read("answer") { AlbumJson.collection(post("/api/v1/collections", AlbumJson.collectionRequest(title))) }

    /** Puts photos already in the album where the member says, a couple of hundred at a time as the album takes them. */
    fun file(photoIds: List<String>, tripId: String?, outingId: String?, collectionId: String?): Filed = read("answer") {
        var filed = 0
        var notYours = 0
        for (some in photoIds.chunked(200)) {
            val r = AlbumJson.filed(post("/api/v1/file", AlbumJson.fileRequest(some, tripId, outingId, collectionId)))
            filed += r.filed
            notYours += r.notYours
        }
        Filed(filed, notYours)
    }

    /** Everything finished in one trip or one collection, a page at a time until there is no more. */
    fun items(kind: String, slug: String): List<AlbumItem> = read("photos") {
        val all = ArrayList<AlbumItem>()
        val trip = kind == "trip"
        var next: String? = ""
        while (next != null && all.size < 5000) {
            val query = if (next.isEmpty()) "" else "?${if (trip) "cursor" else "from"}=${java.net.URLEncoder.encode(next, "UTF-8")}"
            val page = AlbumJson.items(send(request("/api/v1/album/${if (trip) "trips" else "collections"}/$slug$query").get().build()))
            all.addAll(page.items)
            next = if (page.items.isEmpty()) null else page.next
        }
        all
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

    /** The newest few trips, for the front page: the first page of the album's list and no more. */
    fun latestTrips(): List<Show> = read("list") { AlbumJson.shows(send(request("/api/v1/album/trips?from=0").get().build()), "trip").shows.take(8) }

    /** A trip's or a collection's slideshow, with the addresses a television can fetch. `clips` asks for the family's videos among the photos. */
    fun slideShow(kind: String, slug: String, filter: ShowFilter = ShowFilter(), clips: Boolean = false): SlideShow = try {
        AlbumJson.slideShow(send(request("/api/v1/album/slideshow?${Helpers.showQuery(kind, slug, filter, clips)}").get().build()))
    } catch (e: org.json.JSONException) {
        throw AlbumException("The album's slideshow could not be read.")
    }

    /** The album's songs, newest first. */
    fun songs(): List<Song> = try {
        AlbumJson.songs(send(request("/api/v1/album/music").get().build()))
    } catch (e: org.json.JSONException) {
        throw AlbumException("The album's music could not be read.")
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
