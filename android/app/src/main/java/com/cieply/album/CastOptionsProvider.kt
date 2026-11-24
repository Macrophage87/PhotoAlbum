package com.cieply.album

import android.content.Context
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

/**
 * Tells Google's casting library what this app casts to: the album's own page for a television when the build
 * names one (see `Caster.APP_ID`), which shows the photos and plays music under them; otherwise the ordinary
 * receiver every Chromecast and Google TV already has, which shows a picture from an address and nothing more.
 * Named in the manifest, which is how the library finds it.
 */
class CastOptionsProvider : OptionsProvider {
    override fun getCastOptions(context: Context): CastOptions =
        CastOptions.Builder()
            .setReceiverApplicationId(Caster.APP_ID)
            // A slideshow of still pictures has nothing to play or pause, so no media notification or lock-screen controls.
            .setCastMediaOptions(CastMediaOptions.Builder().setNotificationOptions(null).setMediaSessionEnabled(false).build())
            .build()

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null
}
