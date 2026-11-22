package com.cieply.album

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** How far one queued file has got. */
enum class ItemState { WAITING, SENDING, SENT, ALREADY, FAILED }

/** One file the member chose to send. */
data class QueueItem(
    val id: String,
    /** The library's address for the file. */
    val uri: String,
    val video: Boolean,
    val name: String,
    /** Which file on this phone it is: see [Helpers.fileKey]. */
    val key: String,
    val bytes: Long?,
    val lastModifiedMs: Long?,
    val state: ItemState = ItemState.WAITING,
    /** The reason it failed, or a note such as who added it first, written to be shown as it is. */
    val message: String? = null,
    /** The album's id for it once the album has it. */
    val photoId: String? = null,
    val attempts: Int = 0,
)

/** What is kept on disk: the queue, and which of this phone's files the album is known to have. */
data class QueueFile(val items: List<QueueItem>, val sent: Set<String>)

/** The queue's file, written and read. Plain Kotlin, so it is tested on the build machine. */
object QueueJson {
    fun write(file: QueueFile): String {
        val items = JSONArray()
        for (item in file.items) {
            items.put(
                JSONObject()
                    .put("id", item.id)
                    .put("uri", item.uri)
                    .put("video", item.video)
                    .put("name", item.name)
                    .put("key", item.key)
                    .put("bytes", item.bytes ?: JSONObject.NULL)
                    .put("lastModifiedMs", item.lastModifiedMs ?: JSONObject.NULL)
                    .put("state", item.state.name)
                    .put("message", item.message ?: JSONObject.NULL)
                    .put("photoId", item.photoId ?: JSONObject.NULL)
                    .put("attempts", item.attempts),
            )
        }
        return JSONObject().put("items", items).put("sent", JSONArray(file.sent.sorted())).toString()
    }

    /** A file that will not read is an empty queue: nothing in it is worth more than the app starting. */
    fun read(text: String?): QueueFile = try {
        val root = JSONObject(text ?: "")
        val array = root.optJSONArray("items") ?: JSONArray()
        val items = ArrayList<QueueItem>()
        for (i in 0 until array.length()) {
            val o = array.getJSONObject(i)
            val state = try {
                ItemState.valueOf(o.getString("state"))
            } catch (e: IllegalArgumentException) {
                ItemState.WAITING
            }
            items.add(
                QueueItem(
                    id = o.getString("id"),
                    uri = o.getString("uri"),
                    video = o.optBoolean("video", false),
                    name = o.getString("name"),
                    key = o.getString("key"),
                    bytes = if (o.isNull("bytes")) null else o.getLong("bytes"),
                    lastModifiedMs = if (o.isNull("lastModifiedMs")) null else o.getLong("lastModifiedMs"),
                    // One that was mid-flight when the app was stopped starts again; the album recognises a resend.
                    state = if (state == ItemState.SENDING) ItemState.WAITING else state,
                    message = if (o.isNull("message")) null else o.getString("message"),
                    photoId = if (o.isNull("photoId")) null else o.getString("photoId"),
                    attempts = o.optInt("attempts", 0),
                ),
            )
        }
        val sentArray = root.optJSONArray("sent") ?: JSONArray()
        val sent = HashSet<String>()
        for (i in 0 until sentArray.length()) sent.add(sentArray.getString(i))
        QueueFile(items, sent)
    } catch (e: Exception) {
        QueueFile(emptyList(), emptySet())
    }
}

/**
 * The files waiting to go to the album, kept on the phone so that they still go after the app is closed or the
 * phone restarted. One for the whole app: the screens watch it, and the background sender works through it.
 */
class UploadQueue private constructor(private val file: File) {
    private val lock = Any()
    private var current: QueueFile = QueueJson.read(if (file.exists()) file.readText() else null)
    private val shown = MutableStateFlow(current)

    /** The queue as it is now, for a screen to watch. */
    val state: StateFlow<QueueFile> get() = shown

    private fun save(next: QueueFile) {
        current = next
        shown.value = next
        // Written beside and renamed over, so a phone that dies mid-write leaves the old queue, not half a one.
        val beside = File(file.parentFile, file.name + ".new")
        beside.writeText(QueueJson.write(next))
        if (!beside.renameTo(file)) {
            file.writeText(QueueJson.write(next))
            beside.delete()
        }
    }

    /** Adds files to send. One already waiting or being sent is not added twice. Returns how many were added. */
    fun add(items: List<QueueItem>): Int = synchronized(lock) {
        val busy = current.items.filter { it.state == ItemState.WAITING || it.state == ItemState.SENDING }.map { it.key }.toSet()
        val fresh = items.filter { it.key !in busy }.distinctBy { it.key }
        if (fresh.isNotEmpty()) {
            // A file sent again replaces its old line (a failure tried again, say) rather than sitting beside it.
            val keys = fresh.map { it.key }.toSet()
            save(current.copy(items = current.items.filter { it.key !in keys } + fresh))
        }
        fresh.size
    }

    /** Takes the next waiting file and marks it as being sent. */
    fun claimNext(): QueueItem? = synchronized(lock) {
        val next = current.items.firstOrNull { it.state == ItemState.WAITING } ?: return null
        val claimed = next.copy(state = ItemState.SENDING, attempts = next.attempts + 1, message = null)
        save(current.copy(items = current.items.map { if (it.id == next.id) claimed else it }))
        claimed
    }

    /** Records how one file ended. A file the album has is remembered, so the library can tick it. */
    fun finish(id: String, state: ItemState, message: String? = null, photoId: String? = null) = synchronized(lock) {
        val item = current.items.firstOrNull { it.id == id } ?: return@synchronized
        val done = item.copy(state = state, message = message, photoId = photoId ?: item.photoId)
        val inAlbum = state == ItemState.SENT || state == ItemState.ALREADY
        save(QueueFile(current.items.map { if (it.id == id) done else it }, if (inAlbum) current.sent + item.key else current.sent))
    }

    /** Puts back whatever was being sent when the sender stopped. */
    fun releaseSending() = synchronized(lock) {
        if (current.items.any { it.state == ItemState.SENDING }) {
            save(current.copy(items = current.items.map { if (it.state == ItemState.SENDING) it.copy(state = ItemState.WAITING) else it }))
        }
    }

    /** Failed files go back to waiting. Returns how many. */
    fun retryFailed(): Int = synchronized(lock) {
        val failed = current.items.count { it.state == ItemState.FAILED }
        if (failed > 0) {
            save(current.copy(items = current.items.map { if (it.state == ItemState.FAILED) it.copy(state = ItemState.WAITING, message = null) else it }))
        }
        failed
    }

    /** Drops the lines that are over with (sent, already there). What the album has stays remembered. */
    fun clearFinished() = synchronized(lock) {
        save(current.copy(items = current.items.filter { it.state != ItemState.SENT && it.state != ItemState.ALREADY }))
    }

    /** Forgets everything: for signing out, since the next member's album may be another one. */
    fun clear() = synchronized(lock) { save(QueueFile(emptyList(), emptySet())) }

    companion object {
        @Volatile
        private var instance: UploadQueue? = null

        fun get(context: Context): UploadQueue =
            instance ?: synchronized(this) {
                instance ?: UploadQueue(File(context.applicationContext.filesDir, "upload-queue.json")).also { instance = it }
            }

        /** For tests: a queue on a file of the test's choosing. */
        fun on(file: File): UploadQueue = UploadQueue(file)
    }
}
