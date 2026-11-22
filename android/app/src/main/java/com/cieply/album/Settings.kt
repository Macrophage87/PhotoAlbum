package com.cieply.album

import android.content.Context

/** The few choices a member makes about how the app behaves, kept on the phone. */
object Settings {
    private const val FILE = "settings"
    private const val WIFI_ONLY = "wifiOnly"

    /** Whether sending waits for Wi-Fi. Off unless chosen: a holiday is where the photos are, and often the Wi-Fi is not. */
    fun wifiOnly(context: Context): Boolean =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(WIFI_ONLY, false)

    fun setWifiOnly(context: Context, on: Boolean) {
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(WIFI_ONLY, on).apply()
    }
}
