package com.cieply.album

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.MediaStore
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Works through the queue whether or not the app is open. Android runs it when there is a connection, and runs it
 * again later if it was cut short or the album could not be reached: a file sent twice is recognised by the album,
 * so starting one again is always safe.
 */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val queue = UploadQueue.get(applicationContext)
        // Only one of these runs at a time, so anything marked as being sent was left by a run that was stopped.
        queue.releaseSending()
        val signIn = TokenStore(applicationContext).read() ?: return@withContext Result.failure()
        val api = AlbumApi(signIn.baseUrl, signIn.token)
        var limits: Limits? = null
        var worked = false

        /** Stopped with files still to go: they wait, and the notification says they will go on their own. */
        fun later(): Result {
            queue.releaseSending()
            Notifier.waiting(applicationContext, count(queue, ItemState.WAITING), Settings.wifiOnly(applicationContext))
            return Result.retry()
        }

        while (!isStopped) {
            val item = queue.claimNext()
            if (item == null) {
                val inAlbum = count(queue, ItemState.SENT) + count(queue, ItemState.ALREADY)
                val failed = count(queue, ItemState.FAILED)
                val tooBig = count(queue, ItemState.TOO_BIG)
                // Only when this run had something to say: a run that found nothing waiting leaves the shade alone.
                if (worked) Notifier.finished(applicationContext, inAlbum, failed, tooBig) else Notifier.clear(applicationContext)
                return@withContext Result.success()
            }
            worked = true
            Notifier.sending(applicationContext, count(queue, ItemState.WAITING) + 1)
            try {
                if (limits == null) limits = api.me().limits
                val outcome = send(api, item, limits!!)
                queue.finish(item.id, outcome.state, outcome.message, outcome.photoId)
            } catch (e: AlbumException) {
                when {
                    // The sign-in is no longer good. Everything waits for the member to sign in again.
                    e.status == 401 -> {
                        queue.releaseSending()
                        Notifier.clear(applicationContext)
                        return@withContext Result.failure()
                    }
                    // The album looked at this file and said no; its reason is the member's to read.
                    e.status in 400..499 -> queue.finish(item.id, ItemState.FAILED, e.message)
                    else -> return@withContext later()
                }
            } catch (e: TooBig) {
                queue.finish(item.id, ItemState.TOO_BIG, e.message)
            } catch (e: Refused) {
                queue.finish(item.id, ItemState.FAILED, e.message)
            } catch (e: IOException) {
                // No signal, or it dropped part way. Nothing is wrong with the file: it waits.
                return@withContext later()
            } catch (e: SecurityException) {
                queue.finish(item.id, ItemState.FAILED, "Android no longer lets the app read this file. Allow access to photos and send it again.")
            } catch (e: Exception) {
                queue.finish(item.id, ItemState.FAILED, "Could not send this file: ${e.message ?: e.javaClass.simpleName}")
            }
        }
        // Stopped by Android (time is up, or the connection went). What is left waits for the next run.
        later()
    }

    private fun count(queue: UploadQueue, state: ItemState): Int = queue.state.value.items.count { it.state == state }

    /** A video the album takes the kind of, only too big or too long: the member is shown the way round by YouTube. */
    private class TooBig(message: String) : Exception(message)

    /** Something about the file itself means it is not sent; the message is for the member. */
    private class Refused(message: String) : Exception(message)

    private class Outcome(val state: ItemState, val message: String?, val photoId: String?)

    private fun send(api: AlbumApi, item: QueueItem, limits: Limits): Outcome {
        val context = applicationContext
        val uri = Uri.parse(item.uri)
        if (!Media.mediaLocationGranted(context)) {
            throw Refused("Not sent: Android is not letting the app read the location inside photos, so the album would get it without its place. Allow it in the app's permissions, then send again.")
        }
        // The file as it is on disk. Without this Android hands over a copy with the location blanked out.
        val original = MediaStore.setRequireOriginal(uri)
        try {
            context.contentResolver.openInputStream(original)?.close() ?: throw Refused("The phone could not open this file. It may have been deleted.")
        } catch (e: java.io.FileNotFoundException) {
            throw Refused("The phone could not open this file. It may have been deleted.")
        } catch (e: UnsupportedOperationException) {
            throw Refused("Not sent: Android would not hand over the original, so its location would be lost.")
        }

        val mime = context.contentResolver.getType(uri)
        var durationMs: Long? = null
        if (item.video) {
            try {
                val retriever = MediaMetadataRetriever()
                try {
                    retriever.setDataSource(context, uri)
                    durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
                } finally {
                    retriever.release()
                }
            } catch (e: Exception) {
                // A length the phone cannot read is left for the album to judge.
            }
        }
        Helpers.refusal(mime, item.bytes, durationMs, limits)?.let {
            if (Helpers.needsYouTube(mime, item.bytes, durationMs, limits)) throw TooBig(it) else throw Refused(it)
        }

        // Ask before sending: a photo the album has need not cross the mobile network again to be recognised.
        val digest = MessageDigest.getInstance("SHA-256")
        Media.open(context, original).use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                if (isStopped) throw IOException("Stopped")
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        val have = api.have(Helpers.hex(digest.digest()))
        if (have != null) {
            // Nothing is sent. The member's own is still put where they chose, as sending it again would have done;
            // somebody else's is left where it is.
            val wanted = item.tripId != null || item.outingId != null || item.collectionId != null
            val put = have.mine && wanted && try {
                api.file(listOf(have.photoId), item.tripId, item.outingId, item.collectionId).filed > 0
            } catch (e: AlbumException) {
                false
            }
            val note = listOfNotNull(
                if (have.mine) null else "Added by someone else in the family.",
                if (wanted && !put) "It was left where it already is in the album." else null,
            ).joinToString(" ").ifEmpty { null }
            return Outcome(ItemState.ALREADY, note, have.photoId)
        }

        val result = api.upload(
            open = { Media.open(context, original) },
            fileName = item.name,
            mime = mime ?: "application/octet-stream",
            bytes = item.bytes,
            lastModifiedMs = item.lastModifiedMs,
            attempt = item.attempts,
            tripId = item.tripId,
            outingId = item.outingId,
            collectionId = item.collectionId,
        )
        return Outcome(if (result.duplicate) ItemState.ALREADY else ItemState.SENT, null, result.photoId)
    }

    companion object {
        private const val NAME = "uploads"

        /**
         * Says there is something to send. Appended rather than kept: a run that is just finishing may already have
         * looked for more and found none, and what was added after that look must not be left behind.
         */
        fun kick(context: Context) = enqueue(context, ExistingWorkPolicy.APPEND_OR_REPLACE)

        /**
         * Starts over under the rule as it is now, after the member changes "Wi-Fi only": work already waiting keeps
         * the rule it was given. A file cut off part way is sent again from its start, which the album recognises.
         */
        fun restart(context: Context) = enqueue(context, ExistingWorkPolicy.REPLACE)

        private fun enqueue(context: Context, policy: ExistingWorkPolicy) {
            val network = if (Settings.wifiOnly(context)) NetworkType.UNMETERED else NetworkType.CONNECTED
            val request = OneTimeWorkRequestBuilder<UploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(network).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(NAME, policy, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(NAME)
            Notifier.clear(context)
        }
    }
}
