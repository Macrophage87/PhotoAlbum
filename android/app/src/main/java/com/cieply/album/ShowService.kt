package com.cieply.album

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Keeps a slideshow going on the television while the app is in the background, and is its remote control from
 * the notification shade and the lock screen: Back, Play or Pause, Next, and Stop. It runs only while a television
 * is connected. The slideshow itself is `ShowPlayer`; this is what tells Android the app is still doing something
 * the member can see, so Android leaves it running.
 */
class ShowService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channel()
        // The notification follows the slideshow: which photo, and whether it is playing.
        scope.launch {
            combine(ShowPlayer.current, ShowPlayer.playing, ShowPlayer.shown, ShowPlayer.shuffle) { _, _, _, _ -> Unit }.collect {
                if (ShowPlayer.connected != null) post()
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android requires the notification promptly once the service is started, whatever was asked of it.
        post()
        when (intent?.action) {
            BACK -> ShowPlayer.step(-1)
            NEXT -> ShowPlayer.step(1)
            TOGGLE -> ShowPlayer.setPlaying(!(ShowPlayer.playing.value || ShowPlayer.elsewhere.value))
            STOP -> ShowPlayer.stopShow()
        }
        // Started again by Android with nothing to show, or the television has gone: there is nothing to keep going.
        if (ShowPlayer.connected == null) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun channel() {
        val channel = NotificationChannel(CHANNEL, "Slideshow on a TV", NotificationManager.IMPORTANCE_LOW)
        channel.description = "Shows while a slideshow is on a TV, with buttons to move through it."
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun action(name: String, code: Int): PendingIntent = PendingIntent.getService(
        this,
        code,
        Intent(this, ShowService::class.java).setAction(name),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun build(): Notification {
        val slide = ShowPlayer.current.value
        val all = ShowPlayer.shown.value
        val playing = ShowPlayer.playing.value || ShowPlayer.elsewhere.value
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(ShowPlayer.title.ifEmpty { "Slideshow" } + (ShowPlayer.connected?.let { " on $it" } ?: ""))
            .setContentText(Helpers.showLine(all.indexOfFirst { it.id == slide?.id }, all.size, playing, ShowPlayer.seconds.value, ShowPlayer.shuffle.value))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(0, "Back", action(BACK, 1))
            .addAction(0, if (playing) "Pause" else "Play", action(TOGGLE, 2))
            .addAction(0, "Next", action(NEXT, 3))
            .addAction(0, "Stop", action(STOP, 4))
            .build()
    }

    private fun post() {
        try {
            startForeground(ID, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } catch (e: RuntimeException) {
            // Android would not let it stay in front (the app was not on screen when it asked): the slideshow goes on
            // for as long as the app is open, as it did before there was a notification.
            stopSelf()
        }
    }

    companion object {
        private const val CHANNEL = "slideshow"
        private const val ID = 2
        private const val BACK = "com.cieply.album.show.BACK"
        private const val NEXT = "com.cieply.album.show.NEXT"
        private const val TOGGLE = "com.cieply.album.show.TOGGLE"
        private const val STOP = "com.cieply.album.show.STOP"

        fun start(context: Context) {
            try {
                ContextCompat.startForegroundService(context, Intent(context, ShowService::class.java))
            } catch (e: RuntimeException) {
                // Not allowed from the background: see `post`.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ShowService::class.java))
        }
    }
}
