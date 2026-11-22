package com.cieply.album

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class UploadQueueTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun item(n: Int, state: ItemState = ItemState.WAITING) = QueueItem(
        id = "id$n",
        uri = "content://media/external/images/media/$n",
        video = false,
        name = "IMG_$n.jpg",
        key = Helpers.fileKey("IMG_$n.jpg", 1000L + n, 1700000000L + n),
        bytes = 1000L + n,
        lastModifiedMs = (1700000000L + n) * 1000,
        state = state,
    )

    @Test
    fun `the queue survives being written and read`() {
        val file = QueueFile(listOf(item(1), item(2, ItemState.FAILED).copy(message = "Too big", attempts = 2), item(3, ItemState.SENT).copy(photoId = "p3")), setOf("a|1|2"))
        assertEquals(file, QueueJson.read(QueueJson.write(file)))
    }

    @Test
    fun `one that was mid-flight when the app stopped waits again`() {
        val read = QueueJson.read(QueueJson.write(QueueFile(listOf(item(1, ItemState.SENDING)), emptySet())))
        assertEquals(ItemState.WAITING, read.items.single().state)
    }

    @Test
    fun `a file that will not read is an empty queue`() {
        assertEquals(QueueFile(emptyList(), emptySet()), QueueJson.read("not json"))
        assertEquals(QueueFile(emptyList(), emptySet()), QueueJson.read(null))
    }

    @Test
    fun `files are sent in turn, remembered once the album has them, and kept across a restart`() {
        val file = File(folder.root, "queue.json")
        val queue = UploadQueue.on(file)
        assertEquals(2, queue.add(listOf(item(1), item(2))))
        // Chosen again while still waiting: not queued twice.
        assertEquals(0, queue.add(listOf(item(1).copy(id = "again"))))

        val first = queue.claimNext()!!
        assertEquals("id1", first.id)
        assertEquals(1, first.attempts)
        queue.finish(first.id, ItemState.SENT, photoId = "p1")
        val second = queue.claimNext()!!
        queue.finish(second.id, ItemState.FAILED, "The album does not take this kind of file.")
        assertNull(queue.claimNext())

        val reopened = UploadQueue.on(file).state.value
        assertEquals(listOf(ItemState.SENT, ItemState.FAILED), reopened.items.map { it.state })
        assertEquals("p1", reopened.items[0].photoId)
        assertEquals(setOf(item(1).key), reopened.sent)
    }

    @Test
    fun `a failure can be tried again, and what is done can be cleared without forgetting it`() {
        val queue = UploadQueue.on(File(folder.root, "queue.json"))
        queue.add(listOf(item(1), item(2)))
        queue.finish(queue.claimNext()!!.id, ItemState.ALREADY, "Added by someone else in the family.", "p9")
        queue.finish(queue.claimNext()!!.id, ItemState.FAILED, "No")

        assertEquals(1, queue.retryFailed())
        assertEquals(2, queue.claimNext()!!.attempts)
        queue.releaseSending()
        queue.clearFinished()
        val now = queue.state.value
        assertEquals(listOf("id2"), now.items.map { it.id })
        assertEquals(ItemState.WAITING, now.items.single().state)
        assertTrue(item(1).key in now.sent)

        queue.clear()
        assertEquals(QueueFile(emptyList(), emptySet()), queue.state.value)
    }

    @Test
    fun `sending a failed file again replaces its old line`() {
        val queue = UploadQueue.on(File(folder.root, "queue.json"))
        queue.add(listOf(item(1)))
        queue.finish(queue.claimNext()!!.id, ItemState.FAILED, "No")
        assertEquals(1, queue.add(listOf(item(1).copy(id = "second"))))
        assertEquals(listOf("second"), queue.state.value.items.map { it.id })
    }

    @Test
    fun `the trip chosen and the day taken are kept with each file`() {
        val chosen = item(1).copy(tripId = "t1", tripTitle = "Acadia", takenMs = 1754990000000)
        val file = QueueFile(listOf(chosen, item(2)), emptySet())
        val read = QueueJson.read(QueueJson.write(file))
        assertEquals(file, read)
        assertNull(read.items[1].tripId)
    }

    @Test
    fun `a video too big waits for its YouTube link, and counts as in the album once linked`() {
        val queue = UploadQueue.on(File(folder.root, "queue.json"))
        queue.add(listOf(item(1), item(2)))
        val big = queue.claimNext()!!
        queue.finish(big.id, ItemState.TOO_BIG, "This video is 240 seconds long.")
        // Not sent, so not ticked in the library yet, and not swept away with what is done.
        assertTrue(item(1).key !in queue.state.value.sent)
        queue.clearFinished()
        assertEquals(ItemState.TOO_BIG, queue.state.value.items.first { it.id == big.id }.state)

        queue.finish(big.id, ItemState.LINKED, "Falls", "p7")
        val linked = queue.state.value
        assertTrue(item(1).key in linked.sent)
        assertEquals("p7", linked.items.first { it.id == big.id }.photoId)

        // One the member leaves out simply goes.
        val other = queue.claimNext()!!
        queue.finish(other.id, ItemState.TOO_BIG, "Too long")
        queue.remove(other.id)
        assertEquals(listOf(big.id), queue.state.value.items.map { it.id })
        assertTrue(item(2).key !in queue.state.value.sent)
    }
}
