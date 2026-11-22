package com.cieply.album

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * The one notification the app shows: how sending is going, and how it ended. It is only a sign. Sending does not
 * depend on it, so a member who says no to notifications loses nothing but the sign.
 */
object Notifier {
    private const val CHANNEL = "uploads"
    private const val ID = 1

    /** The permission to ask for before the first send, on the Android versions that ask at all. */
    val permission: String? = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.POST_NOTIFICATIONS else null

    fun allowed(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        return Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    private fun channel(context: Context) {
        // Low importance: it sits in the shade without a sound, as a progress bar should.
        val channel = NotificationChannel(CHANNEL, "Sending to the album", NotificationManager.IMPORTANCE_LOW)
        channel.description = "Shows how many photos and videos are still to send."
        context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun builder(context: Context, title: String, text: String): NotificationCompat.Builder {
        channel(context)
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOnlyAlertOnce(true)
    }

    private fun show(context: Context, builder: NotificationCompat.Builder) {
        if (!allowed(context)) return
        try {
            NotificationManagerCompat.from(context).notify(ID, builder.build())
        } catch (e: SecurityException) {
            // Taken away between the check and the call: nothing is shown, and nothing else changes.
        }
    }

    /** While files are going. */
    fun sending(context: Context, left: Int) =
        show(context, builder(context, "Sending to the album", Helpers.progressLine(left)).setOngoing(true).setProgress(0, 0, true))

    /** Stopped part way with files still to go: no connection, or Android called time. They go on their own later. */
    fun waiting(context: Context, left: Int, wifiOnly: Boolean) = show(
        context,
        builder(context, if (wifiOnly) "Waiting for Wi-Fi" else "Waiting for a connection", "${Helpers.progressLine(left)}. They will go on their own."),
    )

    /** Nothing left to send. */
    fun finished(context: Context, inAlbum: Int, failed: Int, tooBig: Int) = show(
        context,
        builder(context, if (failed + tooBig > 0) "Sending finished, with some left over" else "All sent to the album", Helpers.finishedLine(inAlbum, failed, tooBig))
            .setAutoCancel(true),
    )

    fun clear(context: Context) = NotificationManagerCompat.from(context).cancel(ID)
}
