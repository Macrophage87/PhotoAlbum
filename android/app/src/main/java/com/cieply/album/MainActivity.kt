package com.cieply.album

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.util.Size
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items as listItems
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/** Where the app is. A handful of places, and no need of a navigation library. */
private sealed interface Screen {
    data object Setup : Screen
    data object Home : Screen
    data object Pick : Screen
    data object Queue : Screen
    data class Item(val uri: Uri, val origin: Origin) : Screen
}

class MainActivity : ComponentActivity() {
    /** The link the album's website handed back, until the sign-in screen has dealt with it. */
    private val handedBack = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val store = TokenStore(applicationContext)
        if (savedInstanceState == null) handedBack.value = intent?.dataString
        setContent {
            AlbumTheme {
                Surface(Modifier.fillMaxSize().safeDrawingPadding()) {
                    App(store, handedBack.value, onHandled = { handedBack.value = null })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.let { handedBack.value = it }
    }
}

@Composable
private fun App(store: TokenStore, handedBack: String?, onHandled: () -> Unit) {
    var signIn by remember { mutableStateOf(store.read()) }
    var member by remember { mutableStateOf<Member?>(null) }
    var screen by remember { mutableStateOf<Screen>(if (signIn == null) Screen.Setup else Screen.Home) }

    val current = signIn
    if (current == null || screen == Screen.Setup) {
        SetupScreen(
            store = store,
            handedBack = handedBack,
            onHandled = onHandled,
            onSignedIn = { saved, who ->
                store.save(saved)
                store.clearPending()
                signIn = saved
                member = who
                screen = Screen.Home
            },
        )
        return
    }
    val api = remember(current) { AlbumApi(current.baseUrl, current.token) }
    val context = LocalContext.current
    val signOut = {
        // What was waiting was for this member's album; the next sign-in may be someone else's.
        UploadWorker.cancel(context)
        UploadQueue.get(context).clear()
        store.clear()
        signIn = null
        member = null
        screen = Screen.Setup
    }

    when (val at = screen) {
        is Screen.Item -> {
            BackHandler { screen = Screen.Home }
            ItemScreen(api, current.baseUrl, member, at, onBack = { screen = Screen.Home })
        }
        Screen.Pick -> {
            BackHandler { screen = Screen.Home }
            PickScreen(onBack = { screen = Screen.Home }, onQueued = { screen = Screen.Queue })
        }
        Screen.Queue -> {
            BackHandler { screen = Screen.Home }
            QueueScreen(current.baseUrl, onBack = { screen = Screen.Home }, onPickMore = { screen = Screen.Pick })
        }
        else -> HomeScreen(
            api = api,
            baseUrl = current.baseUrl,
            member = member,
            onMember = { member = it },
            onPick = { uri, origin -> screen = Screen.Item(uri, origin) },
            onUpload = { screen = Screen.Pick },
            onQueue = { screen = Screen.Queue },
            onSignOut = signOut,
        )
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = Navy)
}

@Composable
private fun SetupScreen(
    store: TokenStore,
    handedBack: String?,
    onHandled: () -> Unit,
    onSignedIn: (TokenStore.SignIn, Member) -> Unit,
) {
    val context = LocalContext.current
    // The album's address is built into the app when it was built with one; otherwise it is asked for once.
    val builtIn = remember { Helpers.normalizeBaseUrl(BuildConfig.ALBUM_URL) }
    var address by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var waiting by remember { mutableStateOf(store.pending() != null) }
    var problem by remember { mutableStateOf<String?>(null) }

    // The website has handed the member back with a one-time code: trade it, with our secret, for this phone's token.
    // The link is only marked as dealt with (onHandled) once the work is over: clearing it changes this effect's key,
    // and Compose cancels an effect whose key changes, which would cut the exchange off part way.
    LaunchedEffect(handedBack) {
        val link = handedBack ?: return@LaunchedEffect
        val code = Helpers.codeFrom(link)
        val pending = store.pending()
        if (code == null || pending == null) {
            problem = "That sign-in could not be finished. Tap Sign in to start again."
            waiting = false
            onHandled()
            return@LaunchedEffect
        }
        busy = true
        problem = null
        try {
            val (token, who) = withContext(Dispatchers.IO) {
                val token = AlbumApi.exchange(pending.baseUrl, code, pending.verifier)
                token to AlbumApi(pending.baseUrl, token).me()
            }
            store.clearPending()
            onHandled()
            onSignedIn(TokenStore.SignIn(pending.baseUrl, token), who)
        } catch (e: CancellationException) {
            throw e // the screen went away (say, the phone was turned); not a failure to report
        } catch (e: Exception) {
            problem = if (e is AlbumException) e.message else "Could not reach the album: ${e.message ?: e.javaClass.simpleName}"
            busy = false
            waiting = false
            store.clearPending()
            onHandled()
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Heading("Family Album")
        Text("Sign in the same way you do on the album's website. Your browser will open, and then bring you back here.")
        if (builtIn == null) {
            OutlinedTextField(
                value = address,
                onValueChange = { address = it },
                label = { Text("Album address") },
                placeholder = { Text("album.example.com") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        problem?.let { Text(it, color = Rust) }
        if (busy) {
            Progress("Finishing sign-in…")
        } else {
            Button(
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    val baseUrl = builtIn ?: Helpers.normalizeBaseUrl(address)
                    if (baseUrl == null) {
                        problem = "That does not look like the album's address. It should be like album.example.com (https only)."
                    } else {
                        problem = null
                        val verifier = Helpers.newVerifier()
                        store.savePending(TokenStore.Pending(baseUrl, verifier))
                        val url = Helpers.connectUrl(baseUrl, Helpers.challengeOf(verifier), android.os.Build.MODEL ?: "Phone", BuildConfig.APP_SCHEME)
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            waiting = true
                        } catch (e: Exception) {
                            problem = "This phone has no browser to open the album's sign-in page."
                        }
                    }
                },
            ) { Text(if (waiting) "Sign in again" else "Sign in") }
            if (waiting) {
                Text("Waiting for you to finish in the browser. When the page says so, tap \"Back to the Family Album app\".")
            }
        }
    }
}

@Composable
private fun HomeScreen(
    api: AlbumApi,
    baseUrl: String,
    member: Member?,
    onMember: (Member) -> Unit,
    onPick: (Uri, Origin) -> Unit,
    onUpload: () -> Unit,
    onQueue: () -> Unit,
    onSignOut: () -> Unit,
) {
    val context = LocalContext.current
    val queue by UploadQueue.get(context).state.collectAsState()
    // Anything left waiting from last time (the phone was restarted, say) is taken up again.
    LaunchedEffect(Unit) {
        if (queue.items.any { it.state == ItemState.WAITING }) UploadWorker.kick(context)
    }
    // Bumped whenever a permission answer comes back, so everything below is read again.
    var asked by remember { mutableIntStateOf(0) }
    var problem by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(api) {
        if (member == null) {
            try {
                onMember(withContext(Dispatchers.IO) { api.me() })
            } catch (e: AlbumException) {
                if (e.status == 401) onSignOut() else problem = e.message
            } catch (e: Exception) {
                problem = "Could not reach the album: ${e.message ?: e.javaClass.simpleName}"
            }
        }
    }

    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { asked++ }
    val systemPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) onPick(uri, Origin.SYSTEM_PICKER)
    }
    val fileChooser = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) onPick(uri, Origin.FILE_CHOOSER)
    }

    val access = remember(asked) { Media.libraryAccess(context) }
    val location = remember(asked) { Media.mediaLocationGranted(context) }
    val library by produceState(initialValue = emptyList<LibraryItem>(), asked) {
        value = withContext(Dispatchers.IO) { Media.recent(context) }
    }

    LazyVerticalGrid(
        columns = GridCells.Fixed(3),
        modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Heading("Family Album")
                Text(
                    if (member != null) "Signed in to ${baseUrl.removePrefix("https://")} as ${member.name ?: member.email}."
                    else "Signed in to ${baseUrl.removePrefix("https://")}.",
                )
                problem?.let { Text(it, color = Rust) }
                Button(modifier = Modifier.fillMaxWidth(), onClick = onUpload) { Text("Upload photos and videos") }
                summaryOf(queue)?.let { summary ->
                    OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = onQueue) { Text(summary) }
                }
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("What Android allows this app", fontWeight = FontWeight.Bold)
                        Text(
                            when (access) {
                                LibraryAccess.ALL -> "Photos and videos: all of them."
                                LibraryAccess.SELECTED -> "Photos and videos: only the ones you selected."
                                LibraryAccess.NONE -> "Photos and videos: none yet."
                            },
                        )
                        Text(
                            if (location) "Location inside photos: allowed."
                            else "Location inside photos: not allowed, so Android will blank it out.",
                            color = if (location) Good else Rust,
                        )
                        OutlinedButton(onClick = { permissions.launch(Media.wantedPermissions()) }) {
                            Text(if (access == LibraryAccess.NONE) "Allow access" else "Change what is allowed")
                        }
                    }
                }
                Text("Testing one file", fontWeight = FontWeight.Bold)
                Text("Pick one thing to see what Android hands over and what the album makes of it. Each way of picking is tested separately, because Android treats them differently.")
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { systemPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
                ) { Text("Pick with Android's photo picker") }
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { fileChooser.launch(arrayOf("image/*", "video/*")) },
                ) { Text("Pick with Android's file chooser") }
                Text("Or tap one from this phone's library:", fontWeight = FontWeight.Bold)
                if (library.isEmpty()) {
                    Text(if (access == LibraryAccess.NONE) "Allow access above to see the library here." else "Nothing to show yet.")
                }
            }
        }
        items(library, key = { it.uri.toString() }) { entry ->
            Box(Modifier.aspectRatio(1f).background(Color(0xFFE6E9EE)).clickable { onPick(entry.uri, Origin.LIBRARY) }) {
                Thumbnail(entry.uri, Modifier.fillMaxSize())
                if (entry.video) {
                    Text(
                        "Video",
                        color = Color.White,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.align(Alignment.BottomStart).background(Color(0x99000000)).padding(horizontal = 4.dp, vertical = 2.dp),
                    )
                }
            }
        }
        item(span = { GridItemSpan(maxLineSpan) }) {
            TextButton(onClick = onSignOut, modifier = Modifier.padding(vertical = 12.dp)) { Text("Sign out of this phone") }
        }
    }
}

/** The queue in a line, for the button that opens it; null when there is nothing to say. */
private fun summaryOf(queue: QueueFile): String? = Helpers.queueSummary(
    waiting = queue.items.count { it.state == ItemState.WAITING || it.state == ItemState.SENDING },
    inAlbum = queue.items.count { it.state == ItemState.SENT || it.state == ItemState.ALREADY },
    failed = queue.items.count { it.state == ItemState.FAILED },
)

private val dayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("EEEE d MMMM yyyy")

private fun dayOf(ms: Long): LocalDate = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate()

/** The library by day, to choose what goes to the album. Sent from this phone already: ticked, and not chosen again. */
@Composable
private fun PickScreen(onBack: () -> Unit, onQueued: () -> Unit) {
    val context = LocalContext.current
    val queue by UploadQueue.get(context).state.collectAsState()
    var asked by remember { mutableIntStateOf(0) }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { asked++ }
    val access = remember(asked) { Media.libraryAccess(context) }
    val location = remember(asked) { Media.mediaLocationGranted(context) }
    val library by produceState<List<GridItem>?>(initialValue = null, asked) {
        value = withContext(Dispatchers.IO) { Media.library(context) }
    }
    var chosen by remember { mutableStateOf(emptySet<String>()) }

    // Asked the first time the library is wanted, not at install: this is the moment the reason is plain.
    LaunchedEffect(Unit) {
        if (access == LibraryAccess.NONE || !location) permissions.launch(Media.wantedPermissions())
    }

    val all = library
    val days = remember(all) { (all ?: emptyList()).groupBy { dayOf(it.takenMs) }.toList() }
    val busy = remember(queue) { queue.items.filter { it.state == ItemState.WAITING || it.state == ItemState.SENDING }.map { it.key }.toSet() }

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onBack) { Text("‹ Back") }
            Heading("Choose what to send")
            when {
                access == LibraryAccess.NONE -> {
                    Text("The app needs to see this phone's photos to show them here.")
                    Button(onClick = { permissions.launch(Media.wantedPermissions()) }) { Text("Allow access") }
                }
                !location -> {
                    Text("Android is not letting the app read the location inside photos. Sending them without their place would defeat the point, so nothing is sent until that is allowed.", color = Rust)
                    Button(onClick = { permissions.launch(Media.wantedPermissions()) }) { Text("Allow location in photos") }
                }
                access == LibraryAccess.SELECTED -> {
                    Text("Android is only showing the app the photos you selected, so this list is short.")
                    OutlinedButton(onClick = { permissions.launch(Media.wantedPermissions()) }) { Text("Choose which photos") }
                }
            }
        }
        if (all == null) {
            Box(Modifier.weight(1f).fillMaxWidth().padding(20.dp)) { CircularProgressIndicator() }
        } else {
            LazyVerticalGrid(
                columns = GridCells.Fixed(4),
                modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                if (all.isEmpty() && access != LibraryAccess.NONE) {
                    item(span = { GridItemSpan(maxLineSpan) }) { Text("No photos or videos found on this phone.") }
                }
                for ((day, ofDay) in days) {
                    // Only what can still be chosen: not what the album has, and not what is already waiting to go.
                    val open = ofDay.filter { it.key !in queue.sent && it.key !in busy }.map { it.uri.toString() }
                    val allChosen = open.isNotEmpty() && open.all { it in chosen }
                    item(key = "day-$day", span = { GridItemSpan(maxLineSpan) }, contentType = "day") {
                        Row(Modifier.fillMaxWidth().padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(day.format(dayFormat), fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                            if (open.isNotEmpty()) {
                                TextButton(onClick = { chosen = if (allChosen) chosen - open.toSet() else chosen + open }) {
                                    Text(if (allChosen) "Clear day" else "Select day")
                                }
                            }
                        }
                    }
                    items(ofDay, key = { it.uri.toString() }, contentType = { "item" }) { entry ->
                        val id = entry.uri.toString()
                        val sent = entry.key in queue.sent
                        val waiting = entry.key in busy
                        val picked = id in chosen
                        Box(
                            Modifier.aspectRatio(1f).background(Color(0xFFE6E9EE)).clickable(enabled = !sent && !waiting && location) {
                                chosen = if (picked) chosen - id else chosen + id
                            },
                        ) {
                            Thumbnail(entry.uri, Modifier.fillMaxSize())
                            if (picked) Box(Modifier.fillMaxSize().background(Color(0x661F3A5F)))
                            if (sent || waiting) Box(Modifier.fillMaxSize().background(Color(0x99FFFFFF)))
                            val mark = when {
                                sent -> "✓ In the album"
                                waiting -> "Waiting"
                                picked -> "✓ Chosen"
                                entry.video -> "Video"
                                else -> null
                            }
                            if (mark != null) {
                                Text(
                                    mark,
                                    color = Color.White,
                                    style = MaterialTheme.typography.labelSmall,
                                    modifier = Modifier.align(Alignment.BottomStart).background(if (sent) Good else Color(0xCC000000)).padding(horizontal = 4.dp, vertical = 2.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
        Button(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            enabled = chosen.isNotEmpty() && location,
            onClick = {
                val picked = (all ?: emptyList()).filter { it.uri.toString() in chosen }
                UploadQueue.get(context).add(
                    picked.map {
                        QueueItem(
                            id = UUID.randomUUID().toString(),
                            uri = it.uri.toString(),
                            video = it.video,
                            name = it.name,
                            key = it.key,
                            bytes = it.bytes,
                            lastModifiedMs = it.modifiedSeconds?.times(1000),
                        )
                    },
                )
                UploadWorker.kick(context)
                chosen = emptySet()
                onQueued()
            },
        ) { Text(if (chosen.isEmpty()) "Choose photos to send" else "Send ${chosen.size} to the album") }
    }
}

/** Everything chosen, and how far each has got. Sending carries on with the app closed. */
@Composable
private fun QueueScreen(baseUrl: String, onBack: () -> Unit, onPickMore: () -> Unit) {
    val context = LocalContext.current
    val queue by UploadQueue.get(context).state.collectAsState()
    val lines = queue.items
    val failed = lines.count { it.state == ItemState.FAILED }
    val finished = lines.count { it.state == ItemState.SENT || it.state == ItemState.ALREADY }

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onBack) { Text("‹ Back") }
                Heading("Uploads")
                Text(summaryOf(queue) ?: "Nothing has been chosen yet.")
                if (lines.any { it.state == ItemState.WAITING || it.state == ItemState.SENDING }) {
                    Text("These keep sending with the app closed, whenever the phone has a connection. The album then takes a moment to read each one.")
                }
                Button(onClick = onPickMore) { Text("Choose more") }
                if (failed > 0) {
                    OutlinedButton(onClick = { UploadQueue.get(context).retryFailed(); UploadWorker.kick(context) }) { Text("Try the $failed again") }
                }
                if (finished > 0) {
                    TextButton(onClick = { UploadQueue.get(context).clearFinished() }) { Text("Clear the $finished that are done") }
                }
            }
        }
        // What needs attention first, then what is moving, then what is over with.
        val order = listOf(ItemState.FAILED, ItemState.SENDING, ItemState.WAITING, ItemState.SENT, ItemState.ALREADY)
        listItems(lines.sortedBy { order.indexOf(it.state) }, key = { it.id }) { item ->
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(56.dp).background(Color(0xFFE6E9EE))) { Thumbnail(Uri.parse(item.uri), Modifier.fillMaxSize()) }
                    Column(Modifier.padding(start = 10.dp).weight(1f)) {
                        Text(item.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val (label, color) = when (item.state) {
                            ItemState.WAITING -> "Waiting" to Color.Unspecified
                            ItemState.SENDING -> "Sending…" to Navy
                            ItemState.SENT -> "Sent" to Good
                            ItemState.ALREADY -> "Already in the album" to Good
                            ItemState.FAILED -> "Not sent" to Rust
                        }
                        Text(label, color = color, fontWeight = FontWeight.Bold)
                        item.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                    val photoId = item.photoId
                    if (photoId != null) {
                        TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$baseUrl/photos/$photoId"))) }) { Text("Open") }
                    }
                }
            }
        }
    }
}

private fun loadThumbnail(context: Context, uri: Uri): Bitmap? = try {
    context.contentResolver.loadThumbnail(uri, Size(320, 320), null)
} catch (e: Exception) {
    null
}

@Composable
private fun Thumbnail(uri: Uri, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val bitmap by produceState<Bitmap?>(initialValue = null, uri) {
        value = withContext(Dispatchers.IO) { loadThumbnail(context, uri) }
    }
    bitmap?.let { Image(it.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop, modifier = modifier) }
}

/** How far one item has got. */
private sealed interface Sending {
    data object NotYet : Sending
    data object Uploading : Sending
    data class Processing(val result: UploadResult) : Sending
    data class Done(val result: UploadResult, val status: PhotoStatus) : Sending
    data class Failed(val message: String) : Sending
}

@Composable
private fun Fact(label: String, value: String, color: Color = Color.Unspecified) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = Color(0xFF5A6472))
        Text(value, color = color)
    }
}

@Composable
private fun ItemScreen(api: AlbumApi, baseUrl: String, member: Member?, at: Screen.Item, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val inspection by produceState<Inspection?>(initialValue = null, at) {
        value = withContext(Dispatchers.IO) { Media.inspect(context, at.uri, at.origin) }
    }
    var sending by remember(at) { mutableStateOf<Sending>(Sending.NotYet) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TextButton(onClick = onBack) { Text("‹ Back") }
        val found = inspection
        if (found == null) {
            CircularProgressIndicator()
            return@Column
        }
        Heading(found.name)
        Box(Modifier.fillMaxWidth().height(220.dp).background(Color(0xFFE6E9EE))) {
            Thumbnail(at.uri, Modifier.fillMaxSize())
        }
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("On this phone", fontWeight = FontWeight.Bold)
                Fact("Picked with", at.origin.label)
                Fact(
                    "Kind and size",
                    listOfNotNull(
                        found.mime ?: "unknown",
                        found.bytes?.let { Helpers.formatBytes(it) },
                        found.durationMs?.let { "${it / 1000} seconds" },
                    ).joinToString(" · "),
                )
                Fact(
                    "Android hands over the original",
                    if (found.original) "Yes" else "No. ${found.originalRefusal ?: ""}".trim(),
                    if (found.original) Good else Rust,
                )
                Fact(
                    "Location inside the file that will be sent",
                    found.place?.toString() ?: "None found",
                    if (found.place != null) Good else Rust,
                )
            }
        }

        val refusal = member?.let { Helpers.refusal(found.mime, found.bytes, found.durationMs, it.limits) }
        when (val state = sending) {
            Sending.NotYet -> {
                if (refusal != null) {
                    Text(refusal, color = Rust)
                } else {
                    Button(
                        modifier = Modifier.fillMaxWidth(),
                        onClick = {
                            sending = Sending.Uploading
                            scope.launch {
                                sending = try {
                                    val result = withContext(Dispatchers.IO) {
                                        api.upload(
                                            open = { Media.open(context, found.readUri) },
                                            fileName = found.name,
                                            mime = found.mime ?: "application/octet-stream",
                                            bytes = found.bytes,
                                            lastModifiedMs = found.lastModifiedMs,
                                        )
                                    }
                                    Sending.Processing(result)
                                } catch (e: AlbumException) {
                                    Sending.Failed(e.message ?: "The album refused it.")
                                } catch (e: Exception) {
                                    Sending.Failed("Sending failed: ${e.message ?: e.javaClass.simpleName}")
                                }
                            }
                        },
                    ) { Text("Send to the album") }
                }
            }
            Sending.Uploading -> Progress("Sending…")
            is Sending.Processing -> {
                Progress("Sent. The album is reading it…")
                LaunchedEffect(state.result.photoId) {
                    // The album reads the location while it processes, so the answer is only real once that is done.
                    var last: PhotoStatus? = null
                    var problem: String? = null
                    var tries = 0
                    while (tries++ < 90) {
                        try {
                            last = withContext(Dispatchers.IO) { api.status(state.result.photoId) }
                            problem = null
                        } catch (e: Exception) {
                            problem = e.message
                        }
                        if (last?.status == "READY" || last?.status == "FAILED") break
                        delay(2000)
                    }
                    val settled = last
                    sending = if (settled != null && (settled.status == "READY" || settled.status == "FAILED")) {
                        Sending.Done(state.result, settled)
                    } else {
                        Sending.Failed("It was sent, but the album had not finished reading it after three minutes. ${problem ?: ""}".trim())
                    }
                }
            }
            is Sending.Done -> ResultCard(baseUrl, found, state)
            is Sending.Failed -> {
                Text(state.message, color = Rust)
                OutlinedButton(onClick = { sending = Sending.NotYet }) { Text("Try again") }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Progress(text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator()
        Text(text)
    }
}

@Composable
private fun ResultCard(baseUrl: String, found: Inspection, done: Sending.Done) {
    val context = LocalContext.current
    val status = done.status
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("In the album", fontWeight = FontWeight.Bold)
            if (done.result.duplicate) Text("The album already had this exact file, so this is the copy it kept.")
            if (status.status == "FAILED") {
                Fact("Processing", "Failed. ${status.error ?: ""}".trim(), Rust)
            }
            Fact(
                "Where the album put it",
                status.place?.toString() ?: "No place",
                if (status.place != null) Good else Rust,
            )
            Fact(
                "How the album knows",
                when (status.gpsSource) {
                    "EXIF" -> "Read from the file itself"
                    null -> "It does not"
                    else -> "Not from the file (${status.gpsSource})"
                },
            )
            status.takenAt?.let { Fact("Taken", it) }
            val verdict = when {
                status.place != null && status.gpsSource == "EXIF" -> "Passed: the location survived the trip." to Good
                found.place != null -> "Failed: the phone saw a location in the file, but the album did not get one from it." to Rust
                else -> "Nothing to prove here: this file had no location on the phone either." to Color.Unspecified
            }
            Text(verdict.first, color = verdict.second, fontWeight = FontWeight.Bold)
            OutlinedButton(
                onClick = {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$baseUrl/photos/${status.id}")))
                },
            ) { Text("Open it in the album") }
        }
    }
}
