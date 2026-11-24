package com.cieply.album

import android.content.Context
import com.google.android.gms.cast.Cast
import androidx.mediarouter.media.MediaRouteSelector
import androidx.mediarouter.media.MediaRouter
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject

/** A television (or anything else that takes a cast) the phone can see on its Wi-Fi. */
data class CastScreen(val id: String, val name: String)

/** What the television says about its music: which of the songs it was given is on (-1 for none), and whether it is sounding. */
data class TvMusic(val index: Int, val playing: Boolean, val count: Int)

/**
 * What the album's page on the television says is going on, which every connected phone hears: the slide that is up
 * (`id` null when none is yet), whether a phone is moving the slideshow on by itself, and which (`driver`).
 */
data class TvState(
    val id: String?,
    val title: String,
    val day: String,
    val place: String,
    val thumb: String,
    val url: String,
    val show: String,
    val playing: Boolean,
    val driver: String?,
    /** How many phones are connected to the television, this one included. */
    val phones: Int = 1,
)

/**
 * Finds the televisions on the Wi-Fi, connects to one, and puts a picture on it. The television fetches the picture
 * itself from the address it is given; the phone only says which. Everything here is called on the main thread, as
 * Google's casting library requires.
 */
class Caster(context: Context) {
    private val app = context.applicationContext

    // Null on a phone without Google Play services, or where they are too old: there is then nothing to cast with.
    private val castContext: CastContext? = try {
        CastContext.getSharedInstance(app)
    } catch (e: Exception) {
        null
    }
    private val router: MediaRouter? = if (castContext == null) null else MediaRouter.getInstance(app)
    private val selector = MediaRouteSelector.Builder()
        .addControlCategory(CastMediaControlIntent.categoryForCast(APP_ID))
        .build()

    val available: Boolean get() = castContext != null

    private val found = MutableStateFlow<List<CastScreen>>(emptyList())
    private val on = MutableStateFlow<String?>(null)
    private val wrong = MutableStateFlow<String?>(null)
    private val tune = MutableStateFlow<TvMusic?>(null)
    private val said = MutableStateFlow<TvState?>(null)

    /** The screens that can be cast to now. */
    val screens: StateFlow<List<CastScreen>> get() = found

    /** The name of the screen being cast to, or null when there is none. */
    val connected: StateFlow<String?> get() = on

    /** Why connecting did not work, in words for the member. */
    val problem: StateFlow<String?> get() = wrong

    /** What the television last said about its music, or null when it has said nothing (or cannot play any). */
    val music: StateFlow<TvMusic?> get() = tune

    /** What the television last said is on it, or null when it has said nothing. */
    val tv: StateFlow<TvState?> get() = said

    /** Called when the television says a clip has played to its end, with the slide's id. */
    var onClipEnded: ((String?) -> Unit)? = null

    private var session: CastSession? = null

    private fun refresh() {
        val routes = router?.routes ?: emptyList()
        found.value = routes.filter { it.isEnabled && !it.isDefault && it.matchesSelector(selector) }.map { CastScreen(it.id, it.name) }
    }

    private val routes = object : MediaRouter.Callback() {
        override fun onRouteAdded(router: MediaRouter, route: MediaRouter.RouteInfo) = refresh()
        override fun onRouteRemoved(router: MediaRouter, route: MediaRouter.RouteInfo) = refresh()
        override fun onRouteChanged(router: MediaRouter, route: MediaRouter.RouteInfo) = refresh()
    }

    private fun began(s: CastSession) {
        session = s
        wrong.value = null
        if (OWN_PAGE) {
            try {
                s.setMessageReceivedCallbacks(NAMESPACE, Cast.MessageReceivedCallback { _, _, message -> heard(message) })
            } catch (e: Exception) {
                // Then the remote is not told what is playing; the television still does as it is asked.
            }
        }
        // Another phone may have a slideshow up already: ask before putting anything on the screen.
        say(JSONObject().put("type", "hello"))
        on.value = s.castDevice?.friendlyName ?: "the TV"
    }

    private fun heard(message: String) {
        try {
            val o = JSONObject(message)
            when (o.optString("type")) {
                "music" -> tune.value = TvMusic(o.optInt("index", -1), o.optBoolean("playing", false), o.optInt("count", 0))
                "state" -> said.value = TvState(
                    id = if (o.isNull("id")) null else o.optString("id").ifBlank { null },
                    title = o.optString("title"),
                    day = o.optString("day"),
                    place = o.optString("place"),
                    thumb = o.optString("thumb"),
                    url = o.optString("url"),
                    show = o.optString("show"),
                    playing = o.optBoolean("playing", false),
                    driver = if (o.isNull("driver")) null else o.optString("driver").ifBlank { null },
                    phones = o.optInt("phones", 1),
                )
                "clipEnded" -> onClipEnded?.invoke(if (o.isNull("id")) null else o.optString("id"))
            }
        } catch (e: Exception) {
            // Not something the album's page says; nothing to do with it.
        }
    }

    /** Says something to the album's page on the television. Nothing happens when there is no such page or no television. */
    private fun say(message: JSONObject) {
        if (!OWN_PAGE) return
        try {
            session?.sendMessage(NAMESPACE, message.toString())
        } catch (e: Exception) {
            // The television has gone; the session's own listener says so.
        }
    }

    private fun over(message: String?) {
        session = null
        on.value = null
        tune.value = null
        said.value = null
        if (message != null) wrong.value = message
    }

    private val sessions = object : SessionManagerListener<CastSession> {
        override fun onSessionStarting(s: CastSession) {}
        override fun onSessionStarted(s: CastSession, sessionId: String) = began(s)
        override fun onSessionStartFailed(s: CastSession, error: Int) = over("The TV did not connect. Check it is on, and on the same Wi-Fi as this phone.")
        override fun onSessionEnding(s: CastSession) {}
        override fun onSessionEnded(s: CastSession, error: Int) = over(null)
        override fun onSessionResuming(s: CastSession, sessionId: String) {}
        override fun onSessionResumed(s: CastSession, wasSuspended: Boolean) = began(s)
        override fun onSessionResumeFailed(s: CastSession, error: Int) = over(null)
        override fun onSessionSuspended(s: CastSession, reason: Int) {}
    }

    /** Starts looking for screens. Looking uses the Wi-Fi and the battery, so it is stopped when the screen is left. */
    fun start() {
        val context = castContext ?: return
        router?.addCallback(selector, routes, MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY)
        context.sessionManager.addSessionManagerListener(sessions, CastSession::class.java)
        // A cast begun earlier and still going is picked up where it is.
        context.sessionManager.currentCastSession?.takeIf { it.isConnected }?.let { began(it) }
        refresh()
    }

    fun stop() {
        router?.removeCallback(routes)
        castContext?.sessionManager?.removeSessionManagerListener(sessions, CastSession::class.java)
    }

    fun connect(id: String) {
        val route = router?.routes?.firstOrNull { it.id == id }
        if (route == null) {
            wrong.value = "That TV is no longer there. Check it is on."
            return
        }
        wrong.value = null
        router?.selectRoute(route)
    }

    /** Ends the cast: the television goes back to what it shows when idle, whoever else is connected. */
    fun disconnect() {
        castContext?.sessionManager?.endCurrentSession(true)
        over(null)
    }

    /**
     * This phone puts the remote down. The television stops too, unless another phone is still connected to it, in
     * which case the slideshow is theirs to carry on with.
     */
    fun leave() {
        val others = (said.value?.phones ?: 1) > 1
        castContext?.sessionManager?.endCurrentSession(!others)
        over(null)
    }

    /**
     * Puts one slide on the screen. Its picture (and clip) are signed addresses on the album at `base`, which the
     * television fetches itself; the album's own page is given the paths alone, since it only fetches from the album
     * it came from. `card` is the day to announce first, `next` the picture likely to follow (fetched ahead), and
     * `seconds` how long this one will stay.
     */
    fun show(base: String, slide: Slide, card: String?, showTitle: String, next: String?, seconds: Int) {
        if (OWN_PAGE) {
            val message = JSONObject()
                .put("type", "photo")
                .put("url", slide.cast)
                .put("id", slide.id)
                .put("title", slide.title ?: slide.caption ?: "")
                .put("day", slide.day ?: "")
                .put("place", slide.place ?: "")
                .put("people", JSONArray(slide.people))
                .put("show", showTitle)
                .put("thumb", slide.thumb)
                .put("seconds", seconds)
            if (slide.lat != null && slide.lng != null) message.put("lat", slide.lat).put("lng", slide.lng)
            if (card != null) message.put("card", card)
            if (next != null) message.put("next", next)
            if (slide.video != null) message.put("video", slide.video)
            say(message)
            return
        }
        val client = session?.remoteMediaClient ?: return
        val metadata = MediaMetadata(MediaMetadata.MEDIA_TYPE_PHOTO)
        (slide.title ?: slide.caption)?.let { metadata.putString(MediaMetadata.KEY_TITLE, it) }
        slide.place?.let { metadata.putString(MediaMetadata.KEY_LOCATION_NAME, it) }
        val info = MediaInfo.Builder(base + slide.cast)
            .setStreamType(MediaInfo.STREAM_TYPE_NONE)
            .setContentType("image/jpeg")
            .setMetadata(metadata)
            .build()
        client.load(MediaLoadRequestData.Builder().setMediaInfo(info).build())
    }

    /** Tells the television, and through it the other phones, that this phone is (or has stopped) moving the slideshow on. */
    fun playing(on: Boolean, seconds: Int, from: String) = say(JSONObject().put("type", "playing").put("on", on).put("seconds", seconds).put("from", from))

    /** Has the television play these songs (their signed addresses), one after another and round again. None stops the music. */
    fun playMusic(paths: List<String>) = say(JSONObject().put("type", "music").put("songs", JSONArray(paths)))

    fun pauseMusic() = say(JSONObject().put("type", "musicPause"))

    fun resumeMusic() = say(JSONObject().put("type", "musicPlay"))

    fun nextSong() = say(JSONObject().put("type", "musicNext"))

    companion object {
        /** Whether this build casts to the album's own page, which can play music, or to Google's built-in player, which cannot. */
        val OWN_PAGE: Boolean = BuildConfig.CAST_APP_ID.isNotBlank()

        val APP_ID: String = BuildConfig.CAST_APP_ID.ifBlank { CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID }

        /** The channel the phone and the album's page talk on; the same name is in the website's `lib/cast/receiver-page`. */
        const val NAMESPACE = "urn:x-cast:com.cieply.album"
    }
}
