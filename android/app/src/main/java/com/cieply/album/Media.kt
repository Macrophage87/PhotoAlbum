package com.cieply.album

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import java.io.InputStream

/** How an item reached the app. Each way is treated differently by Android, which is what milestone 1 measures. */
enum class Origin(val label: String) {
    LIBRARY("The app's own library view"),
    SYSTEM_PICKER("Android's photo picker"),
    FILE_CHOOSER("Android's file chooser"),
}

data class LibraryItem(val uri: Uri, val video: Boolean)

/** One photo or video in the library, with what is needed to show it by day and to queue it. */
data class GridItem(
    val uri: Uri,
    val video: Boolean,
    val name: String,
    val bytes: Long?,
    val modifiedSeconds: Long?,
    /** When it was taken, as near as the phone knows (it falls back to when it was added). */
    val takenMs: Long,
) {
    val key: String get() = Helpers.fileKey(name, bytes, modifiedSeconds)
}

/** What the phone says about one picked file, read before anything is sent. */
data class Inspection(
    val name: String,
    val mime: String?,
    val bytes: Long?,
    val lastModifiedMs: Long?,
    val video: Boolean,
    val durationMs: Long?,
    /** Whether Android agreed to hand over the file as it is on disk, location and all. */
    val original: Boolean,
    /** Why it did not, in Android's own words. */
    val originalRefusal: String?,
    /** The location found inside the bytes that would be sent. */
    val place: LatLng?,
    /** The address to read the bytes from: the original when Android allowed it. */
    val readUri: Uri,
)

enum class LibraryAccess { ALL, SELECTED, NONE }

object Media {
    private fun granted(context: Context, permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    fun wantedPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VIDEO,
            Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
            Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        Build.VERSION.SDK_INT >= 33 -> arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VIDEO,
            Manifest.permission.ACCESS_MEDIA_LOCATION,
        )
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.ACCESS_MEDIA_LOCATION)
    }

    fun libraryAccess(context: Context): LibraryAccess = when {
        Build.VERSION.SDK_INT >= 33 && granted(context, Manifest.permission.READ_MEDIA_IMAGES) -> LibraryAccess.ALL
        Build.VERSION.SDK_INT >= 34 && granted(context, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> LibraryAccess.SELECTED
        Build.VERSION.SDK_INT < 33 && granted(context, Manifest.permission.READ_EXTERNAL_STORAGE) -> LibraryAccess.ALL
        else -> LibraryAccess.NONE
    }

    fun mediaLocationGranted(context: Context) = granted(context, Manifest.permission.ACCESS_MEDIA_LOCATION)

    /**
     * What a gallery app has thrown away is still a file on the phone for a month or so. Android's own trash is
     * marked as such; Samsung's Gallery moves the file into a hidden ".Trash" folder instead. Neither belongs in a
     * list of things to send to the album, and nor does anything else kept in a hidden folder.
     */
    private const val NOT_THROWN_AWAY =
        "${MediaStore.MediaColumns.IS_TRASHED} = 0 AND ${MediaStore.MediaColumns.IS_PENDING} = 0" +
            " AND (${MediaStore.MediaColumns.RELATIVE_PATH} IS NULL OR (${MediaStore.MediaColumns.RELATIVE_PATH} NOT LIKE '.%'" +
            " AND ${MediaStore.MediaColumns.RELATIVE_PATH} NOT LIKE '%/.%'))"

    /** The newest photos and videos the app is allowed to see. */
    fun recent(context: Context, limit: Int = 90): List<LibraryItem> {
        val items = ArrayList<LibraryItem>()
        val collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
        val columns = arrayOf(MediaStore.Files.FileColumns._ID, MediaStore.Files.FileColumns.MEDIA_TYPE)
        val image = MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
        val video = MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        val where = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN ($image, $video) AND $NOT_THROWN_AWAY"
        val order = "${MediaStore.Files.FileColumns.DATE_ADDED} DESC"
        try {
            context.contentResolver.query(collection, columns, where, null, order)?.use { cursor ->
                while (items.size < limit && cursor.moveToNext()) {
                    val id = cursor.getLong(0)
                    val isVideo = cursor.getInt(1) == video
                    val base = if (isVideo) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    items.add(LibraryItem(ContentUris.withAppendedId(base, id), isVideo))
                }
            }
        } catch (e: SecurityException) {
            // No access to the library: an empty grid, and the screen says why.
        }
        return items
    }

    /** The library, newest first, for picking from. */
    fun library(context: Context, limit: Int = 3000): List<GridItem> {
        val items = ArrayList<GridItem>()
        val collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL)
        val columns = arrayOf(
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.DATE_TAKEN,
            MediaStore.MediaColumns.DATE_ADDED,
        )
        val image = MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
        val video = MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        val where = "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN ($image, $video) AND $NOT_THROWN_AWAY"
        try {
            context.contentResolver.query(collection, columns, where, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(0)
                    val isVideo = cursor.getInt(1) == video
                    val base = if (isVideo) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    val added = if (cursor.isNull(6)) 0L else cursor.getLong(6) * 1000
                    val taken = if (cursor.isNull(5) || cursor.getLong(5) <= 0) added else cursor.getLong(5)
                    items.add(
                        GridItem(
                            uri = ContentUris.withAppendedId(base, id),
                            video = isVideo,
                            name = if (cursor.isNull(2)) "file-$id" else cursor.getString(2),
                            bytes = if (cursor.isNull(3)) null else cursor.getLong(3).takeIf { it > 0 },
                            modifiedSeconds = if (cursor.isNull(4)) null else cursor.getLong(4),
                            takenMs = taken,
                        ),
                    )
                }
            }
        } catch (e: SecurityException) {
            // No access to the library: an empty grid, and the screen says why.
        }
        // Sorted here, not by the provider: "taken" is missing for some files and the fallback is worked out above.
        items.sortByDescending { it.takenMs }
        return if (items.size > limit) items.subList(0, limit) else items
    }

    /**
     * Asks Android for the file as it is on disk. Without this (or when Android refuses) the location is blanked
     * out of what the app is handed, silently. Returns the address to read and, when refused, the reason.
     */
    private fun originalOf(context: Context, uri: Uri, origin: Origin): Pair<Uri?, String?> {
        return try {
            // A file-chooser address is the documents provider's; the same item has a library address when it is media.
            val media = if (origin == Origin.FILE_CHOOSER) MediaStore.getMediaUri(context, uri) ?: uri else uri
            val original = MediaStore.setRequireOriginal(media)
            // Opening it is what finds out: the refusal comes on open, not on asking.
            context.contentResolver.openInputStream(original)?.close()
            original to null
        } catch (e: Exception) {
            null to "${e.javaClass.simpleName}: ${e.message ?: "no reason given"}"
        }
    }

    fun open(context: Context, uri: Uri): InputStream =
        context.contentResolver.openInputStream(uri) ?: throw java.io.IOException("The phone could not open this file.")

    fun inspect(context: Context, uri: Uri, origin: Origin): Inspection {
        val resolver = context.contentResolver
        var name: String? = null
        var bytes: Long? = null
        var modified: Long? = null
        try {
            resolver.query(uri, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameAt = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeAt = cursor.getColumnIndex(OpenableColumns.SIZE)
                    val secondsAt = cursor.getColumnIndex(MediaStore.MediaColumns.DATE_MODIFIED)
                    val millisAt = cursor.getColumnIndex("last_modified")
                    if (nameAt >= 0 && !cursor.isNull(nameAt)) name = cursor.getString(nameAt)
                    if (sizeAt >= 0 && !cursor.isNull(sizeAt)) bytes = cursor.getLong(sizeAt).takeIf { it > 0 }
                    if (secondsAt >= 0 && !cursor.isNull(secondsAt)) modified = cursor.getLong(secondsAt) * 1000
                    else if (millisAt >= 0 && !cursor.isNull(millisAt)) modified = cursor.getLong(millisAt)
                }
            }
        } catch (e: Exception) {
            // Some providers answer nothing; the file can still be sent under a made-up name.
        }
        val mime = resolver.getType(uri)
        val video = mime?.startsWith("video/") == true
        val (original, refusal) = originalOf(context, uri, origin)
        val readUri = original ?: uri

        var place: LatLng? = null
        var durationMs: Long? = null
        try {
            if (video) {
                val retriever = MediaMetadataRetriever()
                try {
                    retriever.setDataSource(context, readUri)
                    place = Helpers.parseIso6709(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_LOCATION))
                    durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
                } finally {
                    retriever.release()
                }
            } else {
                open(context, readUri).use { input ->
                    val found = ExifInterface(input).latLong
                    if (found != null && !(found[0] == 0.0 && found[1] == 0.0)) place = LatLng(found[0], found[1])
                }
            }
        } catch (e: Exception) {
            // Unreadable metadata is reported as "no location found", which is what the album would find too.
        }

        return Inspection(
            name = name ?: "upload-${System.currentTimeMillis()}",
            mime = mime,
            bytes = bytes,
            lastModifiedMs = modified,
            video = video,
            durationMs = durationMs,
            original = original != null,
            originalRefusal = refusal,
            place = place,
            readUri = readUri,
        )
    }
}
