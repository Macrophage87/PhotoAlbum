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

    var title: String = ""
        private set

    private var app: Context? = null
    private var caster: Caster? = null
    private var baseUrl: String = ""
    private var watching: Job? = null
    private var timer: Job? = null
    private var seed: Long = 0
    private var awake: PowerManager.WakeLock? = null

    /** The name of the television, or null when none is connected. */
    val connected: String? get() = caster?.connected?.value

    /** Takes up a slideshow: from here on, whatever is current is put on the television this caster is connected to. */
    fun attach(context: Context, with: Caster, albumUrl: String, showTitle: String) {
        end()
        app = context.applicationContext
        caster = with
        baseUrl = albumUrl
        title = showTitle
        watching = scope.launch {
            with.connected.collect { tv ->
                if (tv != null) {
                    cast()
                    settle()
                    app?.let { ShowService.start(it) }
                } else {
                    going.value = false
                    settle()
                    app?.let { ShowService.stop(it) }
                }
            }
        }
    }

    /** Lets the slideshow go: nothing plays, nothing is current, and the notification leaves. The cast is the caller's to end. */
    fun end() {
        watching?.cancel()
        watching = null
        going.value = false
        settle()
        app?.let { ShowService.stop(it) }
        caster = null
        now.value = null
        listed.value = emptyList()
        mixed.value = false
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
        val all = listed.value
        val order = if (mixed.value) Helpers.shuffled(all, seed) else all
        Helpers.step(order, now.value?.id, by)?.let { show(it) }
    }

    fun setPlaying(on: Boolean) {
        going.value = on
        settle()
    }

    fun setSeconds(value: Int) {
        pace.value = value
        settle()
    }

    /** Turning shuffle on mixes the photos afresh; the one that is up stays up. */
    fun setShuffle(on: Boolean) {
        if (on) seed = System.nanoTime()
        mixed.value = on
    }

    /** Ends the show on the television, from the remote or from the notification. */
    fun stopShow() {
        going.value = false
        settle()
        caster?.disconnect()
    }

    private fun cast() {
        val slide = now.value ?: return
        if (caster?.connected?.value != null) caster?.show(baseUrl + slide.cast, slide.title ?: slide.caption, slide.place)
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
                delay(pace.value * 1000L)
                if (listed.value.size > 1) {
                    val all = listed.value
                    val order = if (mixed.value) Helpers.shuffled(all, seed) else all
                    Helpers.step(order, now.value?.id, 1)?.let {
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
