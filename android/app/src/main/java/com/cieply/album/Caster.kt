package com.cieply.album

import android.content.Context
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

/** A television (or anything else that takes a cast) the phone can see on its Wi-Fi. */
data class CastScreen(val id: String, val name: String)

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
        .addControlCategory(CastMediaControlIntent.categoryForCast(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
        .build()

    val available: Boolean get() = castContext != null

    private val found = MutableStateFlow<List<CastScreen>>(emptyList())
    private val on = MutableStateFlow<String?>(null)
    private val wrong = MutableStateFlow<String?>(null)

    /** The screens that can be cast to now. */
    val screens: StateFlow<List<CastScreen>> get() = found

    /** The name of the screen being cast to, or null when there is none. */
    val connected: StateFlow<String?> get() = on

    /** Why connecting did not work, in words for the member. */
    val problem: StateFlow<String?> get() = wrong

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
        on.value = s.castDevice?.friendlyName ?: "the TV"
    }

    private fun over(message: String?) {
        session = null
        on.value = null
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

    /** Ends the cast: the television goes back to what it shows when idle. */
    fun disconnect() {
        castContext?.sessionManager?.endCurrentSession(true)
        over(null)
    }

    /** Puts one picture on the screen. `url` is the whole address the television will fetch. */
    fun show(url: String, title: String?, place: String?) {
        val client = session?.remoteMediaClient ?: return
        val metadata = MediaMetadata(MediaMetadata.MEDIA_TYPE_PHOTO)
        if (title != null) metadata.putString(MediaMetadata.KEY_TITLE, title)
        if (place != null) metadata.putString(MediaMetadata.KEY_LOCATION_NAME, place)
        val info = MediaInfo.Builder(url)
            .setStreamType(MediaInfo.STREAM_TYPE_NONE)
            .setContentType("image/jpeg")
            .setMetadata(metadata)
            .build()
        client.load(MediaLoadRequestData.Builder().setMediaInfo(info).build())
    }
}
