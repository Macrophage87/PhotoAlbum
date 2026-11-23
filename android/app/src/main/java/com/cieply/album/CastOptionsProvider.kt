package com.cieply.album

import android.content.Context
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

/**
 * Tells Google's casting library what this app casts to: the ordinary receiver every Chromecast and Google TV
 * already has, which shows a picture from an address. No receiver of our own, so nothing to register or host.
 * Named in the manifest, which is how the library finds it.
 */
class CastOptionsProvider : OptionsProvider {
    override fun getCastOptions(context: Context): CastOptions =
        CastOptions.Builder()
            .setReceiverApplicationId(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID)
            // A slideshow of still pictures has nothing to play or pause, so no media notification or lock-screen controls.
            .setCastMediaOptions(CastMediaOptions.Builder().setNotificationOptions(null).setMediaSessionEnabled(false).build())
            .build()

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null
}
