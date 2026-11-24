package com.cieply.album

import android.content.Context
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The slideshow that is on the television: which photo, whether it is playing by itself, how fast, and in what
 * order. It lives outside any screen so that it keeps going when the app is in the background or the phone's
 * screen is off: the remote screen draws it, the notification (see `ShowService`) drives it too, and neither owns
 * it. Everything here is called on the main thread, as the casting library requires.
 */
object ShowPlayer {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val now = MutableStateFlow<Slide?>(null)
    private val going = MutableStateFlow(false)
    private val pace = MutableStateFlow(10)
    private val mixed = MutableStateFlow(false)
    private val listed = MutableStateFlow<List<Slide>>(emptyList())
    private val tunes = MutableStateFlow<List<Song>>(emptyList())
    private val other = MutableStateFlow(false)

    /** What is on the television, or will be once one is chosen. */
    val current: StateFlow<Slide?> get() = now

    /** Whether it is moving on by itself. */
    val playing: StateFlow<Boolean> get() = going

    /** Seconds each photo stays up while playing. */
    val seconds: StateFlow<Int> get() = pace

    /** Whether Next goes through the photos in a mixed-up order rather than the order they are listed in. */
    val shuffle: StateFlow<Boolean> get() = mixed

    /** The photos Next and Back move through, in the order they are listed. */
    val shown: StateFlow<List<Slide>> get() = listed

    /** Whether another phone is moving this television's slideshow on by itself. */
    val elsewhere: StateFlow<Boolean> get() = other

    /** The songs the television has been asked to play under the photos, in the order it plays them. */
    val songs: StateFlow<List<Song>> get() = tunes

    var title: String = ""
        private set

    private var app: Context? = null
    private var caster: Caster? = null
    private var baseUrl: String = ""
    private var watching: Job? = null
    private var timer: Job? = null
    private var seed: Long = 0
    private var awake: PowerManager.WakeLock? = null

    /** This phone, to the television and the other phones: so each knows whether it is the one moving the slideshow on. */
    private val me: String = java.util.UUID.randomUUID().toString()

    /** Whether the television has said what is on it since this phone connected; until it has, nothing is put up. */
    private var greeted = true
    private var greeting: Job? = null

    /** When this phone last said it was playing or pausing: what the television says just after may be older news. */
    private var claimedAt = 0L

    /** The day of the last slide this phone put up, so a new day is announced once. */
    private var showingDay: String? = null

    /** The name of the television, or null when none is connected. */
    val connected: String? get() = caster?.connected?.value

    /** Takes up a slideshow: from here on, whatever is current is put on the television this caster is connected to. */
    fun attach(context: Context, with: Caster, albumUrl: String, showTitle: String) {
        end()
        app = context.applicationContext
        caster = with
        baseUrl = albumUrl
        title = showTitle
        with.onClipEnded = { id -> if (going.value && id != null && id == now.value?.id) step(1) }
        watching = scope.launch {
            launch {
                with.connected.collect { tv ->
                    if (tv != null) {
                        if (Caster.OWN_PAGE) {
                            // Another phone may have a slideshow up: the television is asked first (see `Caster.began`),
                            // and this phone's photo goes up only if nothing is on, or if no answer comes.
                            greeted = false
                            greeting?.cancel()
                            greeting = launch {
                                delay(2500)
                                if (!greeted) {
                                    greeted = true
                                    begin()
                                }
                            }
                        } else {
                            begin()
                        }
                        // A television that comes back mid-show (the Wi-Fi dropped) starts its page afresh, so it is told its music again.
                        if (tunes.value.isNotEmpty()) with.playMusic(tunes.value.map { it.cast })
                        settle()
                        app?.let { ShowService.start(it) }
                    } else {
                        going.value = false
                        other.value = false
                        settle()
                        app?.let { ShowService.stop(it) }
                    }
                }
            }
            launch { with.tv.collect { said -> if (said != null) heard(said) } }
        }
    }

    /** Puts this phone's slideshow on a television that has nothing on it. */
    private fun begin() {
        if (going.value) caster?.playing(true, pace.value, me)
        cast()
    }

    /**
     * The television says what is on it. Another phone may have changed the photo, or started or stopped it moving
     * on: this phone shows the same, and never has two phones moving it on at once.
     */
    private fun heard(said: TvState) {
        if (!greeted) {
            greeted = true
            greeting?.cancel()
            if (said.id == null) {
                begin()
                return
            }
        }
        if (said.id != null && said.id != now.value?.id) {
            now.value = listed.value.firstOrNull { it.id == said.id }
                ?: Slide(said.id, said.title.ifBlank { null }, null, said.day.ifBlank { null }, said.place.ifBlank { null }, said.thumb, said.url)
            settle()
        }
        val mine = said.playing && said.driver == me
        other.value = said.playing && !mine
        // Somebody else paused it or took it over. Just after this phone's own Play, the news may be older than that.
        if (going.value && !mine && android.os.SystemClock.elapsedRealtime() - claimedAt > 1500) {
            going.value = false
            settle()
        }
    }

    /** Lets the slideshow go: nothing plays, nothing is current, and the notification leaves. The cast is the caller's to end. */
    fun end() {
        watching?.cancel()
        watching = null
        greeting = null
        greeted = true
        other.value = false
        showingDay = null
        caster?.onClipEnded = null
        going.value = false
        settle()
        app?.let { ShowService.stop(it) }
        caster = null
        now.value = null
        listed.value = emptyList()
        mixed.value = false
        tunes.value = emptyList()
    }

    /**
     * A list fetched again: the photo that is up keeps its place, with its fresh address, and nothing is sent to the
     * television for it. With nothing up yet, the first photo is.
     */
    fun adopt(slides: List<Slide>) {
        val held = now.value
        val fresh = slides.firstOrNull { it.id == held?.id }
        if (fresh != null) now.value = fresh else if (held == null) slides.firstOrNull()?.let { show(it) }
    }

    /** What Next and Back move through from now on. */
    fun list(slides: List<Slide>) {
        listed.value = slides
    }

    /** Puts this photo up. While playing, the wait for the next one starts again from here. */
    fun show(slide: Slide) {
        val changed = slide.id != now.value?.id
        now.value = slide
        if (changed) cast()
        settle()
    }

    /** On (`by` 1) or back (`by` -1) through the photos, in the mixed-up order when shuffle is on. */
    fun step(by: Int) {
        Helpers.step(order(), now.value?.id, by)?.let { show(it) }
    }

    /** Starts or stops the slideshow moving on by itself. Stopping stops it whichever phone was moving it. */
    fun setPlaying(on: Boolean) {
        going.value = on
        if (!on) other.value = false
        claimedAt = android.os.SystemClock.elapsedRealtime()
        caster?.playing(on, pace.value, me)
        settle()
    }

    fun setSeconds(value: Int) {
        pace.value = value
        if (going.value) caster?.playing(true, value, me)
        settle()
    }

    /** Turning shuffle on mixes the photos afresh; the one that is up stays up. */
    fun setShuffle(on: Boolean) {
        if (on) seed = System.nanoTime()
        mixed.value = on
    }

    /** Has the television play these songs under the photos, in this order and round again. None stops the music. */
    fun setMusic(list: List<Song>) {
        tunes.value = list
        caster?.playMusic(list.map { it.cast })
    }

    fun pauseMusic() = caster?.pauseMusic()

    fun resumeMusic() = caster?.resumeMusic()

    fun nextSong() = caster?.nextSong()

    /** Ends the show on the television, from the remote or from the notification. */
    fun stopShow() {
        going.value = false
        settle()
        caster?.disconnect()
    }

    private fun order(): List<Slide> = if (mixed.value) Helpers.shuffled(listed.value, seed) else listed.value

    private fun cast() {
        val slide = now.value ?: return
        val tv = caster ?: return
        // Not before the television has said whether another phone's slideshow is already on it.
        if (tv.connected.value == null || !greeted) return
        val next = Helpers.step(order(), slide.id, 1)?.takeIf { it.id != slide.id }
        val card = Helpers.dayCard(slide, showingDay)
        showingDay = slide.dayKey ?: showingDay
        tv.show(baseUrl, slide, card, title, next?.cast, pace.value)
    }

    /** Starts or stops the clock that moves on, and keeps the phone's processor awake only while it is needed. */
    private fun settle() {
        timer?.cancel()
        timer = null
        val run = going.value && caster?.connected?.value != null
        hold(run)
        if (!run) return
        timer = scope.launch {
            while (isActive) {
                // A clip is waited out: the television says when it ends (see `attach`), and this is the fallback.
                delay(Helpers.waitMs(now.value, pace.value))
                if (listed.value.size > 1) {
                    Helpers.step(order(), now.value?.id, 1)?.let {
                        now.value = it
                        cast()
                    }
                }
            }
        }
    }

    /**
     * With the screen off a phone stops counting seconds for apps unless one asks it not to. Held only while a
     * slideshow is playing by itself on a television, and let go by the phone itself after six hours whatever happens.
     */
    private fun hold(on: Boolean) {
        try {
            if (on) {
                if (awake?.isHeld == true) return
                val power = app?.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
                awake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FamilyAlbum:slideshow").also { it.acquire(6 * 60 * 60 * 1000L) }
            } else {
                awake?.takeIf { it.isHeld }?.release()
                awake = null
            }
        } catch (e: RuntimeException) {
            // Without it the slideshow still plays while the screen is on.
        }
    }
}
