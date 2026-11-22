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

    /**
     * Whether a file the album refuses is one for YouTube: a video the album does take the kind of, only too big or
     * too long. The album keeps short clips; a longer video is put on YouTube and its link added to the album.
     */
    fun needsYouTube(mime: String?, bytes: Long?, durationMs: Long?, limits: Limits): Boolean {
        val type = mime?.lowercase(Locale.US) ?: return false
        if (type !in limits.videoTypes) return false
        return (bytes != null && bytes > limits.videoBytes) || (durationMs != null && durationMs > limits.clipSeconds * 1000L)
    }

    /** A moment as the calendar day it fell on where the phone is ("2025-08-12"): how the album is told a video's day. */
    fun dayString(ms: Long, zone: java.time.ZoneId): String = java.time.Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().toString()

    /** "10 to 16 August 2025", "30 July to 2 August 2025": a trip's days in a line, from the album's own dates. */
    fun tripDays(start: String, end: String): String = try {
        val a = java.time.LocalDate.parse(start)
        val b = java.time.LocalDate.parse(end)
        val full = java.time.format.DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.US)
        when {
            a == b -> a.format(full)
            a.year == b.year && a.month == b.month -> "${a.dayOfMonth} to ${b.format(full)}"
            a.year == b.year -> "${a.format(java.time.format.DateTimeFormatter.ofPattern("d MMMM", Locale.US))} to ${b.format(full)}"
            else -> "${a.format(full)} to ${b.format(full)}"
        }
    } catch (e: Exception) {
        ""
    }

    /** What the notification says while files are going, and when they have all gone. */
    fun progressLine(left: Int): String = if (left == 1) "1 left to send" else "$left left to send"

    fun finishedLine(inAlbum: Int, failed: Int, tooBig: Int): String {
        val parts = ArrayList<String>()
        if (inAlbum > 0) parts.add("$inAlbum in the album")
        if (failed > 0) parts.add("$failed not sent")
        if (tooBig > 0) parts.add(if (tooBig == 1) "1 video is too big and needs YouTube" else "$tooBig videos are too big and need YouTube")
        return if (parts.isEmpty()) "Nothing left to send" else parts.joinToString(", ")
    }

    /**
     * Which file on this phone something is, without reading it: its name, size and when it was last changed.
     * Android's own ids are no good for this (they change on a new phone), and a hash means reading the whole file.
     */
    fun fileKey(name: String, bytes: Long?, modifiedSeconds: Long?): String = "$name|${bytes ?: "?"}|${modifiedSeconds ?: "?"}"

    /** A digest as the album writes one: lower-case hex. */
    fun hex(digest: ByteArray): String = digest.joinToString("") { String.format(Locale.US, "%02x", it.toInt() and 0xff) }

    /** "3 waiting, 12 in the album, 1 failed": the queue in a line, or null when it is empty. */
    fun queueSummary(waiting: Int, inAlbum: Int, failed: Int, tooBig: Int = 0): String? {
        val parts = ArrayList<String>()
        if (waiting > 0) parts.add("$waiting waiting to send")
        if (inAlbum > 0) parts.add("$inAlbum in the album")
        if (failed > 0) parts.add("$failed not sent")
        if (tooBig > 0) parts.add("$tooBig for YouTube")
        return if (parts.isEmpty()) null else parts.joinToString(", ")
    }

    fun formatBytes(bytes: Long): String = when {
        bytes >= 1L shl 30 -> String.format(Locale.US, "%.1f GB", bytes / (1L shl 30).toDouble())
        bytes >= 1L shl 20 -> String.format(Locale.US, "%.1f MB", bytes / (1L shl 20).toDouble())
        else -> String.format(Locale.US, "%d KB", (bytes + 1023) / 1024)
    }
}
