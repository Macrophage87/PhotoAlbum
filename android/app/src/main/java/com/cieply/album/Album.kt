package com.cieply.album

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items as listItems
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/*
 * The album itself in the app: its trips and collections, what is in each, one photo at a time, and the making of a
 * trip, an activity or a collection and the putting of photos on them, as the website does these.
 */

private val shortDay: DateTimeFormatter = DateTimeFormatter.ofPattern("d MMM yyyy")
private val Pale = Color(0xFFE6E9EE)

/** Asks the album something off the main thread. What goes wrong is said through `say`, and the answer is then null. */
private suspend fun <T> asking(say: (String?) -> Unit, what: () -> T): T? = try {
    say(null)
    withContext(Dispatchers.IO) { what() }
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    say(if (e is AlbumException) e.message else "Could not reach the album: ${e.message ?: e.javaClass.simpleName}")
    null
}

private fun dayOfMs(ms: Long): LocalDate = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate()

private fun parseDay(day: String): LocalDate? = try {
    LocalDate.parse(day)
} catch (e: Exception) {
    null
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DayButton(label: String, day: LocalDate, modifier: Modifier = Modifier, onChange: (LocalDate) -> Unit) {
    var open by remember { mutableStateOf(false) }
    OutlinedButton(modifier = modifier, onClick = { open = true }) { Text("$label ${day.format(shortDay)}".trim(), maxLines = 1) }
    if (open) {
        // The picker counts days in UTC whatever the phone's zone is, so the day goes in and comes out that way.
        val state = rememberDatePickerState(initialSelectedDateMillis = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                Button(onClick = {
                    state.selectedDateMillis?.let { onChange(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                    open = false
                }) { Text("OK") }
            },
            dismissButton = { OutlinedButton(onClick = { open = false }) { Text("Cancel") } },
        ) { DatePicker(state = state) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeButton(hour: Int, minute: Int, modifier: Modifier = Modifier, onChange: (Int, Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    OutlinedButton(modifier = modifier, onClick = { open = true }) { Text(Helpers.clock(hour, minute), maxLines = 1) }
    if (open) {
        val state = rememberTimePickerState(initialHour = hour, initialMinute = minute, is24Hour = false)
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = { Button(onClick = { onChange(state.hour, state.minute); open = false }) { Text("OK") } },
            dismissButton = { OutlinedButton(onClick = { open = false }) { Text("Cancel") } },
            text = { TimePicker(state = state) },
        )
    }
}

@Composable
private fun Chip(label: String, chosen: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (chosen) Color.White else Navy,
        fontWeight = if (chosen) FontWeight.Bold else FontWeight.Normal,
        modifier = Modifier.background(if (chosen) Navy else Pale).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp),
    )
}

/** Makes a trip. Its days start as the days of what is being put on it, when anything is. */
@Composable
internal fun NewTripDialog(api: AlbumApi, span: Pair<Long, Long>?, onMade: (Trip) -> Unit, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var start by remember { mutableStateOf(span?.let { dayOfMs(it.first) } ?: LocalDate.now()) }
    var end by remember { mutableStateOf(span?.let { dayOfMs(it.second) } ?: LocalDate.now()) }
    var problem by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("New trip") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                DayButton("From", start, Modifier.fillMaxWidth()) { start = it; if (end.isBefore(it)) end = it }
                DayButton("To", end, Modifier.fillMaxWidth()) { end = it; if (start.isAfter(it)) start = it }
                Text("Only the family can see a new trip. Sharing it is changed on the website.", style = MaterialTheme.typography.bodySmall)
                problem?.let { Text(it, color = Rust) }
            }
        },
        confirmButton = {
            Button(
                enabled = !busy && title.isNotBlank(),
                onClick = {
                    scope.launch {
                        busy = true
                        val made = asking({ problem = it }) { api.createTrip(title, start.toString(), end.toString(), ZoneId.systemDefault().id) }
                        busy = false
                        if (made != null) onMade(made)
                    }
                },
            ) { Text(if (busy) "Making…" else "Make the trip") }
        },
        dismissButton = { OutlinedButton(onClick = onClose) { Text("Cancel") } },
    )
}

/** Makes an activity on a trip. Its hours start as those of what is being put on it, when anything is. */
@Composable
internal fun NewOutingDialog(api: AlbumApi, trip: Trip, kinds: List<OutingKind>, span: Pair<Long, Long>?, onMade: (Outing) -> Unit, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    val zone = ZoneId.systemDefault()
    val from = span?.let { Instant.ofEpochMilli(it.first).atZone(zone) }
    // A minute past the last one, so that the last photo falls inside it.
    val to = span?.let { Instant.ofEpochMilli(it.second).atZone(zone).plusMinutes(1) }
    val firstDay = from?.toLocalDate() ?: parseDay(trip.startDate) ?: LocalDate.now()
    var title by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf("OTHER") }
    var startDay by remember { mutableStateOf(firstDay) }
    var startHour by remember { mutableIntStateOf(from?.hour ?: 9) }
    var startMinute by remember { mutableIntStateOf(from?.minute ?: 0) }
    var endDay by remember { mutableStateOf(to?.toLocalDate() ?: firstDay) }
    var endHour by remember { mutableIntStateOf(to?.hour ?: 12) }
    var endMinute by remember { mutableIntStateOf(to?.minute ?: 0) }
    var problem by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("New activity on ${trip.title}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (kinds.isNotEmpty()) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (k in kinds) Chip(k.label, k.type == kind) { kind = k.type }
                    }
                }
                Text("Starts", fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    DayButton("", startDay, Modifier.weight(1f)) { startDay = it; if (endDay.isBefore(it)) endDay = it }
                    TimeButton(startHour, startMinute) { h, m -> startHour = h; startMinute = m }
                }
                Text("Ends", fontWeight = FontWeight.Bold)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    DayButton("", endDay, Modifier.weight(1f)) { endDay = it }
                    TimeButton(endHour, endMinute) { h, m -> endHour = h; endMinute = m }
                }
                Text("Times are the clock's where the trip was. Photos taken on the trip in these hours are put on the activity.", style = MaterialTheme.typography.bodySmall)
                problem?.let { Text(it, color = Rust) }
            }
        },
        confirmButton = {
            Button(
                enabled = !busy && title.isNotBlank(),
                onClick = {
                    scope.launch {
                        busy = true
                        val made = asking({ problem = it }) {
                            api.createOuting(trip.id, title, kind, Helpers.wallTime(startDay, startHour, startMinute), Helpers.wallTime(endDay, endHour, endMinute))
                        }
                        busy = false
                        if (made != null) onMade(made)
                    }
                },
            ) { Text(if (busy) "Making…" else "Make the activity") }
        },
        dismissButton = { OutlinedButton(onClick = onClose) { Text("Cancel") } },
    )
}

@Composable
internal fun NewCollectionDialog(api: AlbumApi, onMade: (CollectionName) -> Unit, onClose: () -> Unit) {
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("New collection") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("A collection gathers photos from any trips, such as \"Christmas mornings\". Only the family can see a new one.", style = MaterialTheme.typography.bodySmall)
                problem?.let { Text(it, color = Rust) }
            }
        },
        confirmButton = {
            Button(
                enabled = !busy && title.isNotBlank(),
                onClick = {
                    scope.launch {
                        busy = true
                        val made = asking({ problem = it }) { api.createCollection(title) }
                        busy = false
                        if (made != null) onMade(made)
                    }
                },
            ) { Text(if (busy) "Making…" else "Make the collection") }
        },
        dismissButton = { OutlinedButton(onClick = onClose) { Text("Cancel") } },
    )
}

/** A choice in a list, drawn as a button: outlined, and filled when it is the one chosen. */
@Composable
internal fun Line(title: String, detail: String = "", chosen: Boolean = false, onClick: () -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(shape).background(if (chosen) Navy else Color.Transparent).border(1.dp, Navy, shape)
            .clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Text(if (chosen) "✓ $title" else title, fontWeight = FontWeight.Bold, color = if (chosen) Color.White else Navy)
        if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = if (chosen) Color.White else Color.Unspecified)
    }
}

private enum class Choosing { WHERE, TRIP, OUTING, COLLECTION, NEW_TRIP, NEW_OUTING, NEW_COLLECTION }

/**
 * Where photos go: a trip, one of its activities, a collection, or any of them, each chosen from the album's own or
 * made here. `byDate` is for sending from the phone, where no trip means the album files each one by its date.
 * `span` is the first and last moments of what is being put there, which a new trip or activity starts from.
 */
@Composable
internal fun FilingDialog(api: AlbumApi, filing: Filing, byDate: Boolean, span: Pair<Long, Long>?, onChange: (Filing) -> Unit, onClose: () -> Unit) {
    var at by remember { mutableStateOf(Choosing.WHERE) }
    var problem by remember { mutableStateOf<String?>(null) }
    var trips by remember { mutableStateOf<List<Trip>?>(null) }
    var collections by remember { mutableStateOf<List<CollectionName>?>(null) }
    var outings by remember { mutableStateOf<TripOutings?>(null) }
    LaunchedEffect(api) {
        trips = asking({ problem = it }) { api.trips() } ?: emptyList()
        collections = asking({ if (it != null) problem = it }) { api.collections() } ?: emptyList()
    }
    val tripId = filing.trip?.id
    LaunchedEffect(tripId) {
        outings = null
        if (tripId != null) outings = asking({ if (it != null) problem = it }) { api.outings(tripId) } ?: TripOutings(emptyList(), emptyList(), false)
    }

    val trip = filing.trip
    when (at) {
        Choosing.NEW_TRIP -> return NewTripDialog(api, span, onMade = { trips = listOf(it) + (trips ?: emptyList()); onChange(filing.copy(trip = it, outing = null)); at = Choosing.WHERE }, onClose = { at = Choosing.TRIP })
        Choosing.NEW_OUTING -> if (trip != null) {
            return NewOutingDialog(
                api, trip, outings?.kinds ?: emptyList(), span,
                onMade = { made -> outings = outings?.let { it.copy(outings = it.outings + made) }; onChange(filing.copy(outing = made)); at = Choosing.WHERE },
                onClose = { at = Choosing.OUTING },
            )
        }
        Choosing.NEW_COLLECTION -> return NewCollectionDialog(api, onMade = { collections = (collections ?: emptyList()) + it; onChange(filing.copy(collection = it)); at = Choosing.WHERE }, onClose = { at = Choosing.COLLECTION })
        else -> {}
    }

    AlertDialog(
        onDismissRequest = onClose,
        confirmButton = {
            if (at == Choosing.WHERE) Button(onClick = onClose) { Text("Done") } else OutlinedButton(onClick = { at = Choosing.WHERE }) { Text("Back") }
        },
        title = {
            Text(
                when (at) {
                    Choosing.TRIP -> "Which trip?"
                    Choosing.OUTING -> "Which activity?"
                    Choosing.COLLECTION -> "Which collection?"
                    else -> "Where do they go?"
                },
            )
        },
        text = {
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                problem?.let { said -> item { Text(said, color = Rust, modifier = Modifier.padding(vertical = 8.dp)) } }
                when (at) {
                    Choosing.TRIP -> {
                        item {
                            if (byDate) Line("Let the album decide", "Each one goes to the trip its date falls on.", trip == null) { onChange(filing.copy(trip = null, outing = null)); at = Choosing.WHERE }
                            else Line("No trip", "Leave them on the trip they are on.", trip == null) { onChange(filing.copy(trip = null, outing = null)); at = Choosing.WHERE }
                        }
                        item { Line("＋ New trip") { at = Choosing.NEW_TRIP } }
                        val list = trips
                        if (list == null) item { Text("Fetching the album's trips…", modifier = Modifier.padding(vertical = 8.dp)) }
                        else listItems(list, key = { it.id }) { t ->
                            Line(t.title, Helpers.tripDays(t.startDate, t.endDate), trip?.id == t.id) {
                                onChange(if (trip?.id == t.id) filing else filing.copy(trip = t, outing = null))
                                at = Choosing.WHERE
                            }
                        }
                    }
                    Choosing.OUTING -> {
                        item { Line("No activity", "The album files each one by the time it was taken.", filing.outing == null) { onChange(filing.copy(outing = null)); at = Choosing.WHERE } }
                        val found = outings
                        when {
                            found == null -> item { Text("Fetching the trip's activities…", modifier = Modifier.padding(vertical = 8.dp)) }
                            found.canAdd -> item { Line("＋ New activity") { at = Choosing.NEW_OUTING } }
                            else -> item { Text("Only whoever made this trip, or an admin, can add an activity to it.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 8.dp)) }
                        }
                        if (found != null) listItems(found.outings, key = { it.id }) { o ->
                            Line(o.title, "${o.label} · ${o.start.replace('T', ' ')}", filing.outing?.id == o.id) { onChange(filing.copy(outing = o)); at = Choosing.WHERE }
                        }
                    }
                    Choosing.COLLECTION -> {
                        item { Line("No collection", "", filing.collection == null) { onChange(filing.copy(collection = null)); at = Choosing.WHERE } }
                        item { Line("＋ New collection") { at = Choosing.NEW_COLLECTION } }
                        val list = collections
                        if (list == null) item { Text("Fetching the album's collections…", modifier = Modifier.padding(vertical = 8.dp)) }
                        else listItems(list, key = { it.id }) { c ->
                            Line(c.title, "", filing.collection?.id == c.id) { onChange(filing.copy(collection = c)); at = Choosing.WHERE }
                        }
                    }
                    else -> {
                        item { Line("Trip", trip?.title ?: if (byDate) "The album decides by date" else "Not chosen") { at = Choosing.TRIP } }
                        item {
                            if (trip == null) Line("Activity", "Choose a trip first") { at = Choosing.TRIP }
                            else Line("Activity", filing.outing?.title ?: "None") { at = Choosing.OUTING }
                        }
                        item { Line("Collection", filing.collection?.title ?: "None") { at = Choosing.COLLECTION } }
                    }
                }
            }
        },
    )
}

@Composable
private fun PlaceCard(api: AlbumApi, show: Show, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(84.dp).background(Pale)) {
                show.cover?.let { AlbumPicture(api, it, Modifier.fillMaxSize(), ContentScale.Crop) }
            }
            Column(Modifier.padding(12.dp)) {
                Text(show.title, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val count = if (show.items == 1) "1 item" else "${show.items} items"
                Text(if (show.detail.isEmpty()) count else "${show.detail} · $count", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** The album's trips and collections, to open one, and the making of a new one. */
@Composable
internal fun BrowseScreen(api: AlbumApi, onBack: () -> Unit, onOpen: (Show) -> Unit) {
    var problem by remember { mutableStateOf<String?>(null) }
    var said by remember { mutableStateOf<String?>(null) }
    var again by remember { mutableIntStateOf(0) }
    var shows by remember { mutableStateOf<List<Show>?>(null) }
    var making by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(api, again) {
        shows = asking({ problem = it }) { api.shows("trip") + api.shows("collection") } ?: shows ?: emptyList()
    }
    when (making) {
        "trip" -> NewTripDialog(api, null, onMade = { making = null; said = "Made the trip ${it.title}."; again++ }, onClose = { making = null })
        "collection" -> NewCollectionDialog(api, onMade = { making = null; said = "Made the collection ${it.title}."; again++ }, onClose = { making = null })
    }
    val list = shows
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onBack) { Text("‹ Back") }
                Heading("The album")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(modifier = Modifier.weight(1f), onClick = { making = "trip" }) { Text("＋ New trip") }
                    OutlinedButton(modifier = Modifier.weight(1f), onClick = { making = "collection" }) { Text("＋ New collection") }
                }
                said?.let { Text(it, color = Good) }
                problem?.let { Text(it, color = Rust) }
                if (list == null) Progress("Fetching the album's trips and collections…")
                if (list != null && list.isEmpty() && problem == null) Text("The album has no trips or collections yet.")
            }
        }
        if (list != null) {
            for (kind in listOf("trip", "collection")) {
                val ofKind = list.filter { it.kind == kind }
                if (ofKind.isEmpty()) continue
                item(key = "heading-$kind") { Text(if (kind == "trip") "Trips" else "Collections", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp)) }
                listItems(ofKind, key = { "${it.kind}-${it.slug}" }) { show -> PlaceCard(api, show) { onOpen(show) } }
            }
        }
    }
}

/** One photo at a time, swiped through, with what is written on it. */
@Composable
private fun Viewer(api: AlbumApi, baseUrl: String, items: List<AlbumItem>, first: Int, onClose: () -> Unit) {
    val context = LocalContext.current
    val pager = rememberPagerState(initialPage = first.coerceIn(0, (items.size - 1).coerceAtLeast(0))) { items.size }
    BackHandler(onBack = onClose)
    Column(Modifier.fillMaxSize().background(Color.Black)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = onClose, border = BorderStroke(1.dp, Color.White), modifier = Modifier.padding(8.dp)) { Text("‹ Back", color = Color.White) }
            Text("${pager.currentPage + 1} of ${items.size}", color = Color.White, modifier = Modifier.weight(1f).padding(start = 4.dp))
        }
        HorizontalPager(state = pager, modifier = Modifier.weight(1f).fillMaxWidth()) { page ->
            val item = items[page]
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                AlbumPicture(api, item.medium, Modifier.fillMaxSize(), ContentScale.Fit)
                if (item.video) Text("Video: open it on the website to play", color = Color.White, modifier = Modifier.align(Alignment.BottomCenter).background(Color(0x99000000)).padding(8.dp))
            }
        }
        val item = items.getOrNull(pager.currentPage)
        if (item != null) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                (item.caption ?: item.title)?.let { Text(it, color = Color.White, fontWeight = FontWeight.Bold) }
                val where = listOfNotNull(item.day?.let { Helpers.dayLabel(it, true) }, item.place).joinToString(" · ")
                if (where.isNotEmpty()) Text(where, color = Color(0xFFCFD6E0), style = MaterialTheme.typography.bodySmall)
                if (item.page.isNotEmpty()) {
                    OutlinedButton(border = BorderStroke(1.dp, Color.White), onClick = {
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(baseUrl + item.page)))
                        } catch (e: Exception) {
                            // No browser to open it with: nothing to do.
                        }
                    }) { Text("Open on the website", color = Color.White) }
                }
            }
        }
    }
}

/**
 * One trip or one collection: its photos by day, each opened by a tap. "Select photos" turns taps into choosing,
 * and what is chosen can be put on a trip, an activity or a collection.
 */
@Composable
internal fun PlaceScreen(api: AlbumApi, baseUrl: String, show: Show, onBack: () -> Unit, onTv: (Show) -> Unit) {
    val scope = rememberCoroutineScope()
    val grid = rememberLazyGridState()
    var problem by remember { mutableStateOf<String?>(null) }
    var said by remember { mutableStateOf<String?>(null) }
    var again by remember { mutableIntStateOf(0) }
    var items by remember { mutableStateOf<List<AlbumItem>?>(null) }
    var outings by remember { mutableStateOf<TripOutings?>(null) }
    var viewing by remember { mutableStateOf<Int?>(null) }
    var selecting by remember { mutableStateOf(false) }
    var chosen by remember { mutableStateOf(emptySet<String>()) }
    var filing by remember { mutableStateOf(Filing()) }
    var choosingWhere by remember { mutableStateOf(false) }
    var makingOuting by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val isTrip = show.kind == "trip"
    val asTrip = Trip(show.id, show.title, show.startDate, show.endDate)

    LaunchedEffect(api, show, again) {
        items = asking({ problem = it }) { api.items(show.kind, show.slug) } ?: items ?: emptyList()
        if (isTrip && show.id.isNotEmpty()) outings = asking({ }) { api.outings(show.id) }
    }

    val all = items ?: emptyList()
    val open = viewing
    if (open != null && all.isNotEmpty()) {
        Viewer(api, baseUrl, all, open, onClose = { viewing = null })
        return
    }
    BackHandler {
        if (selecting) {
            selecting = false
            chosen = emptySet()
        } else onBack()
    }
    if (choosingWhere) FilingDialog(api, filing, byDate = false, span = null, onChange = { filing = it }, onClose = { choosingWhere = false })
    if (makingOuting) {
        NewOutingDialog(api, asTrip, outings?.kinds ?: emptyList(), null, onMade = { makingOuting = false; said = "Made the activity ${it.title}."; again++ }, onClose = { makingOuting = false })
    }
    val days = remember(all) { all.groupBy { it.day ?: "" }.toList() }

    Column(Modifier.fillMaxSize()) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            state = grid,
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(3.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onBack) { Text("‹ Back") }
                    Heading(show.title)
                    if (show.detail.isNotEmpty()) Text(show.detail)
                    show.description?.let { Text(it) }
                    outings?.outings?.takeIf { it.isNotEmpty() }?.let { list ->
                        Text("Activities: ${list.joinToString(", ") { it.title }}", style = MaterialTheme.typography.bodySmall)
                    }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { selecting = !selecting; chosen = emptySet(); said = null }) { Text(if (selecting) "Stop selecting" else "Select photos") }
                        if (isTrip && outings?.canAdd == true) OutlinedButton(onClick = { makingOuting = true }) { Text("＋ New activity") }
                        OutlinedButton(onClick = { onTv(show) }) { Text("Show on a TV") }
                    }
                    if (selecting) Text("Tap photos to choose them, then say where they go. Only photos you added can be moved, unless you are an admin.", style = MaterialTheme.typography.bodySmall)
                    said?.let { Text(it, color = Good) }
                    problem?.let { Text(it, color = Rust) }
                    if (items == null) Progress("Fetching the photos…")
                    if (items != null && all.isEmpty() && problem == null) Text("Nothing here yet.")
                }
            }
            for ((day, ofDay) in days) {
                val mine = ofDay.filter { it.mine }.map { it.id }
                val allChosen = mine.isNotEmpty() && mine.all { it in chosen }
                item(key = "day-$day", span = { GridItemSpan(maxLineSpan) }, contentType = "day") {
                    Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(if (day.isEmpty()) "No date" else Helpers.dayLabel(day, true), fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        if (selecting && mine.isNotEmpty()) {
                            OutlinedButton(onClick = { chosen = if (allChosen) chosen - mine.toSet() else chosen + mine }) { Text(if (allChosen) "Clear day" else "Select day") }
                        }
                    }
                }
                items(ofDay, key = { it.id }, contentType = { "item" }) { entry ->
                    val picked = entry.id in chosen
                    Box(
                        Modifier.aspectRatio(1f).background(Pale).clickable(enabled = !selecting || entry.mine) {
                            if (selecting) chosen = if (picked) chosen - entry.id else chosen + entry.id
                            else viewing = all.indexOfFirst { it.id == entry.id }.coerceAtLeast(0)
                        },
                    ) {
                        AlbumPicture(api, entry.thumb, Modifier.fillMaxSize(), ContentScale.Crop)
                        if (picked) Box(Modifier.fillMaxSize().background(Color(0x661F3A5F)))
                        if (selecting && !entry.mine) Box(Modifier.fillMaxSize().background(Color(0x99FFFFFF)))
                        val mark = when {
                            picked -> "✓ Chosen"
                            selecting && !entry.mine -> "Not yours"
                            entry.video -> "Video"
                            else -> null
                        }
                        if (mark != null) {
                            Text(mark, color = Color.White, style = MaterialTheme.typography.labelSmall, modifier = Modifier.align(Alignment.BottomStart).background(Color(0xCC000000)).padding(horizontal = 4.dp, vertical = 2.dp))
                        }
                    }
                }
            }
        }
        if (selecting) {
            OutlinedButton(modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp), onClick = { choosingWhere = true }) {
                Text(Helpers.filingLine(filing, byDate = false), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Button(
                modifier = Modifier.fillMaxWidth().padding(12.dp),
                enabled = !busy && chosen.isNotEmpty() && filing.chosen,
                onClick = {
                    val ids = all.filter { it.id in chosen }.map { it.id }
                    val where = filing
                    scope.launch {
                        busy = true
                        val done = asking({ problem = it }) { api.file(ids, where.trip?.id, where.outing?.id, where.collection?.id) }
                        busy = false
                        if (done != null) {
                            said = Helpers.filedLine(done, Helpers.filingNames(where))
                            chosen = emptySet()
                            selecting = false
                            again++
                        }
                    }
                },
            ) {
                Text(
                    when {
                        busy -> "Putting them there…"
                        chosen.isEmpty() -> "Choose photos"
                        !filing.chosen -> "Say where ${chosen.size} should go"
                        else -> "Put ${chosen.size} there"
                    },
                )
            }
        }
    }
}
