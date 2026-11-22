package com.cieply.album

import java.net.URI
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.Locale

/** What the album will take, as its own `/api/v1/me` reports it. */
data class Limits(
    val photoBytes: Long,
    val videoBytes: Long,
    val clipSeconds: Int,
    val imageTypes: Set<String>,
    val videoTypes: Set<String>,
)

data class Member(val email: String, val name: String?, val limits: Limits)

data class LatLng(val lat: Double, val lng: Double) {
    override fun toString(): String = String.format(Locale.US, "%.5f, %.5f", lat, lng)
}

/** Everything here is plain Kotlin with no Android in it, so it is tested on the build machine. */
object Helpers {
    /**
     * The album's address as someone would type it ("album.example.com", with or without https:// or a trailing
     * slash) made into the origin every request starts from. Plain http is refused: the token rides on each request.
     */
    fun normalizeBaseUrl(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty() || trimmed.any { it.isWhitespace() }) return null
        val withScheme = if (trimmed.contains("://")) trimmed else "https://$trimmed"
        val uri = try {
            URI(withScheme)
        } catch (e: Exception) {
            return null
        }
        if (!"https".equals(uri.scheme, ignoreCase = true)) return null
        val host = uri.host ?: return null
        if (uri.userInfo != null) return null
        val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
        return "https://${host.lowercase(Locale.US)}$port"
    }

    private val urlSafe = Base64.getUrlEncoder().withoutPadding()

    /** A secret this app makes when it asks to sign in, and never sends until the very last step. */
    fun newVerifier(): String = urlSafe.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })

    /**
     * What is sent in place of the secret when asking: its SHA-256. The album gives a sign-in only to whoever can
     * show the secret this was made from, so a code caught on its way back to the app is of no use to anyone else.
     */
    fun challengeOf(verifier: String): String =
        urlSafe.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    /** The page on the album's website where a member signs in and says this phone may be connected. */
    fun connectUrl(baseUrl: String, challenge: String, phoneName: String, scheme: String): String =
        "$baseUrl/account/phone?challenge=$challenge&app=${encodeFileName(scheme)}&name=${encodeFileName(phoneName)}"

    /** The one-time code in the link the website hands back, when it has the shape of one. */
    fun codeFrom(link: String?): String? =
        Regex("^[a-z-]+://connect\\?(?:.*&)?code=([A-Za-z0-9_-]{43})(?:&.*)?$").find(link ?: "")?.groupValues?.get(1)

    /** A file name for the `x-file-name` header, percent-encoded the way a browser's encodeURIComponent would. */
    fun encodeFileName(name: String): String = URLEncoder.encode(name, "UTF-8").replace("+", "%20")

    /**
     * A video's location as the file carries it (ISO 6709: "+38.8977-077.0365/" or with an altitude after it).
     * Null when there is none or it is the 0,0 a camera writes for "unknown".
     */
    fun parseIso6709(raw: String?): LatLng? {
        if (raw == null) return null
        val m = Regex("^([+-]\\d+(?:\\.\\d+)?)([+-]\\d+(?:\\.\\d+)?)").find(raw.trim()) ?: return null
        val lat = m.groupValues[1].toDoubleOrNull() ?: return null
        val lng = m.groupValues[2].toDoubleOrNull() ?: return null
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
        if (lat == 0.0 && lng == 0.0) return null
        return LatLng(lat, lng)
    }

    /** Why the album would refuse this file, in words for whoever picked it; null when it would be taken. */
    fun refusal(mime: String?, bytes: Long?, durationMs: Long?, limits: Limits): String? {
        val type = mime?.lowercase(Locale.US) ?: return "The phone could not tell what kind of file this is."
        val video = type in limits.videoTypes
        if (!video && type !in limits.imageTypes) return "The album does not take this kind of file ($type)."
        val max = if (video) limits.videoBytes else limits.photoBytes
        if (bytes != null && bytes > max) {
            return "This is ${formatBytes(bytes)}; the album takes ${if (video) "videos" else "photos"} up to ${formatBytes(max)}."
        }
        if (video && durationMs != null && durationMs > limits.clipSeconds * 1000L) {
            return "This video is ${durationMs / 1000} seconds long; the album takes clips up to ${limits.clipSeconds} seconds. Longer videos go on YouTube and are linked from the album."
        }
        return null
    }

    fun formatBytes(bytes: Long): String = when {
        bytes >= 1L shl 30 -> String.format(Locale.US, "%.1f GB", bytes / (1L shl 30).toDouble())
        bytes >= 1L shl 20 -> String.format(Locale.US, "%.1f MB", bytes / (1L shl 20).toDouble())
        else -> String.format(Locale.US, "%d KB", (bytes + 1023) / 1024)
    }
}
