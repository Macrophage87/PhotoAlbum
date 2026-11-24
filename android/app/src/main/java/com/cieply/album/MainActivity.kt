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
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items as listItems
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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

    /** The way round for one video too big for the album: put it on YouTube, paste its link. */
    data class YouTube(val itemId: String) : Screen

    /** The album's trips and collections, to look through. */
    data object Browse : Screen

    /** One trip or one collection, and its photos. `fromHome` is where Back goes. */
    data class Place(val show: Show, val fromHome: Boolean = false) : Screen

    /** What Android allows the app, sending on Wi-Fi, trying one file, and signing out. */
    data object More : Screen

    /** Choosing a trip or a collection to show on a television. */
    data object Shows : Screen

    /** The remote control for one slideshow on a television. */
    data class Remote(val show: Show, val from: Screen = Shows) : Screen
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
    // Asked for the first time something is sent, by whichever screen sends it. The answer changes nothing but
    // whether the progress is shown, so nothing waits on it.
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val askToNotify = {
        val permission = Notifier.permission
        if (permission != null && !Notifier.allowed(context)) notifications.launch(permission)
    }
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
            BackHandler { screen = Screen.More }
            ItemScreen(api, current.baseUrl, member, at, onBack = { screen = Screen.More })
        }
        Screen.Pick -> {
            BackHandler { screen = Screen.Home }
            PickScreen(api, onBack = { screen = Screen.Home }, onQueued = { screen = Screen.Queue; askToNotify() })
        }
        Screen.Queue -> {
            BackHandler { screen = Screen.Home }
            QueueScreen(current.baseUrl, onBack = { screen = Screen.Home }, onPickMore = { screen = Screen.Pick }, onYouTube = { screen = Screen.YouTube(it) })
        }
        Screen.Shows -> {
            BackHandler { screen = Screen.Home }
            ShowsScreen(api, onBack = { screen = Screen.Home }, onChoose = { screen = Screen.Remote(it) })
        }
        is Screen.Remote -> {
            BackHandler { screen = at.from }
            RemoteScreen(api, current.baseUrl, at.show, onBack = { screen = at.from })
        }
        Screen.Browse -> {
            BackHandler { screen = Screen.Home }
            BrowseScreen(api, onBack = { screen = Screen.Home }, onOpen = { screen = Screen.Place(it) })
        }
        is Screen.Place -> {
            // Its own back handling comes first: leaving a photo, then leaving selecting, then this.
            val back = { screen = if (at.fromHome) Screen.Home else Screen.Browse }
            PlaceScreen(api, current.baseUrl, at.show, onBack = back, onTv = { screen = Screen.Remote(it, at) })
        }
        Screen.More -> {
            BackHandler { screen = Screen.Home }
            MoreScreen(onBack = { screen = Screen.Home }, onPick = { uri, origin -> screen = Screen.Item(uri, origin) }, onSignOut = signOut)
        }
        is Screen.YouTube -> {
            BackHandler { screen = Screen.Queue }
            YouTubeScreen(api, at.itemId, onBack = { screen = Screen.Queue })
        }
        else -> HomeScreen(
            api = api,
            baseUrl = current.baseUrl,
            member = member,
            onMember = { member = it },
            onUpload = { screen = Screen.Pick },
            onQueue = { screen = Screen.Queue },
            onSlideshow = { screen = Screen.Shows },
            onBrowse = { screen = Screen.Browse },
            onOpen = { screen = Screen.Place(it, fromHome = true) },
            onMore = { screen = Screen.More },
            onSignOut = signOut,
        )
    }
}

@Composable
internal fun Heading(text: String) {
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

/** A big button for the front page: what it does, and a line about it. */
@Composable
private fun HomeCard(title: String, detail: String, strong: Boolean = false, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = if (strong) CardDefaults.cardColors(containerColor = Navy, contentColor = Color.White) else CardDefaults.cardColors(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(detail, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** The front page: the album's latest trips to open, and the few things the app does. */
@Composable
private fun HomeScreen(
    api: AlbumApi,
    baseUrl: String,
    member: Member?,
    onMember: (Member) -> Unit,
    onUpload: () -> Unit,
    onQueue: () -> Unit,
    onSlideshow: () -> Unit,
    onBrowse: () -> Unit,
    onOpen: (Show) -> Unit,
    onMore: () -> Unit,
    onSignOut: () -> Unit,
) {
    val context = LocalContext.current
    val queue by UploadQueue.get(context).state.collectAsState()
    // Anything left waiting from last time (the phone was restarted, say) is taken up again.
    LaunchedEffect(Unit) {
        if (queue.items.any { it.state == ItemState.WAITING }) UploadWorker.kick(context)
    }
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
    // The newest trips, for a row to open one from. Without them the page still does everything else.
    val latest by produceState<List<Show>>(initialValue = emptyList(), api) {
        value = try {
            withContext(Dispatchers.IO) { api.latestTrips() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            emptyList()
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Heading("Family Album")
        Text(
            if (member != null) "Hello, ${member.name ?: member.email}." else "Signed in to ${baseUrl.removePrefix("https://")}.",
        )
        problem?.let { Text(it, color = Rust) }

        if (latest.isNotEmpty()) {
            Text("Latest trips", fontWeight = FontWeight.Bold)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for (show in latest) {
                    Column(Modifier.width(150.dp).clickable { onOpen(show) }, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Box(Modifier.fillMaxWidth().aspectRatio(4f / 3f).background(Color(0xFFE6E9EE))) {
                            show.cover?.let { AlbumPicture(api, it, Modifier.fillMaxSize(), ContentScale.Crop) }
                        }
                        Text(show.title, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (show.detail.isNotEmpty()) Text(show.detail, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }

        HomeCard("Browse the album", "Trips, collections and their photos. Make a new trip, activity or collection, and put photos on them.", strong = true, onClick = onBrowse)
        HomeCard("Upload photos and videos", "Choose from this phone, and say which trip, activity or collection they go to.", onClick = onUpload)
        summaryOf(queue)?.let { summary ->
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = onQueue) { Text(summary) }
        }
        HomeCard("Show a slideshow on a TV", "Pictures on the television, with this phone as the remote control.", onClick = onSlideshow)
        HomeCard("Settings", "Wi-Fi only, what Android allows the app, and signing out.", onClick = onMore)
    }
}

/** The settings and the testing tools: what Android allows, sending on Wi-Fi, trying one file, and signing out. */
@Composable
private fun MoreScreen(onBack: () -> Unit, onPick: (Uri, Origin) -> Unit, onSignOut: () -> Unit) {
    val context = LocalContext.current
    // Bumped whenever a permission answer comes back, so everything below is read again.
    var asked by remember { mutableIntStateOf(0) }
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
                OutlinedButton(onClick = onBack) { Text("‹ Back") }
                Heading("Settings")
                WifiOnlySwitch()
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
                OutlinedButton(onClick = onSignOut) { Text("Sign out of this phone") }
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
    }
}

/** The queue in a line, for the button that opens it; null when there is nothing to say. */
private fun summaryOf(queue: QueueFile): String? = Helpers.queueSummary(
    waiting = queue.items.count { it.state == ItemState.WAITING || it.state == ItemState.SENDING },
    inAlbum = queue.items.count { it.state == ItemState.SENT || it.state == ItemState.ALREADY },
    failed = queue.items.count { it.state == ItemState.FAILED },
    tooBig = queue.items.count { it.state == ItemState.TOO_BIG },
)

/** "Wi-Fi only", where it can be seen and changed. What is waiting is started again under the new rule. */
@Composable
private fun WifiOnlySwitch() {
    val context = LocalContext.current
    var on by remember { mutableStateOf(Settings.wifiOnly(context)) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("Send on Wi-Fi only", fontWeight = FontWeight.Bold)
            Text(
                if (on) "Photos and videos wait until this phone is on Wi-Fi." else "Photos and videos are sent on mobile data too.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Switch(
            checked = on,
            onCheckedChange = {
                on = it
                Settings.setWifiOnly(context, it)
                val waiting = UploadQueue.get(context).state.value.items.any { item -> item.state == ItemState.WAITING || item.state == ItemState.SENDING }
                if (waiting) UploadWorker.restart(context)
            },
        )
    }
}

@Composable
private fun TripLine(title: String, detail: String, chosen: Boolean, onClick: () -> Unit) = Line(title, detail, chosen, onClick)

private val dayFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("EEEE d MMMM yyyy")

private fun dayOf(ms: Long): LocalDate = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).toLocalDate()

/** The library by day, to choose what goes to the album. Sent from this phone already: ticked, and not chosen again. */
@Composable
private fun PickScreen(api: AlbumApi, onBack: () -> Unit, onQueued: () -> Unit) {
    val context = LocalContext.current
    var filing by remember { mutableStateOf(Filing()) }
    var choosingWhere by remember { mutableStateOf(false) }
    val queue by UploadQueue.get(context).state.collectAsState()
    var asked by remember { mutableIntStateOf(0) }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { asked++ }
    val access = remember(asked) { Media.libraryAccess(context) }
    val location = remember(asked) { Media.mediaLocationGranted(context) }
    val library by produceState<List<GridItem>?>(initialValue = null, asked) {
        value = withContext(Dispatchers.IO) { Media.library(context) }
    }
    var chosen by remember { mutableStateOf(emptySet<String>()) }
    if (choosingWhere) {
        // A new trip or activity made here starts from the days and hours of what is chosen.
        val span = Helpers.span((library ?: emptyList()).filter { it.uri.toString() in chosen }.map { it.takenMs })
        FilingDialog(api, filing, byDate = true, span = span, onChange = { filing = it }, onClose = { choosingWhere = false })
    }

    // Asked the first time the library is wanted, not at install: this is the moment the reason is plain.
    LaunchedEffect(Unit) {
        if (access == LibraryAccess.NONE || !location) permissions.launch(Media.wantedPermissions())
    }

    val all = library
    val days = remember(all) { (all ?: emptyList()).groupBy { dayOf(it.takenMs) }.toList() }
    val busy = remember(queue) { queue.items.filter { it.state == ItemState.WAITING || it.state == ItemState.SENDING }.map { it.key }.toSet() }

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onBack) { Text("‹ Back") }
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
                                OutlinedButton(onClick = { chosen = if (allChosen) chosen - open.toSet() else chosen + open }) {
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
        OutlinedButton(modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp), onClick = { choosingWhere = true }) {
            Text(Helpers.filingLine(filing, byDate = true), maxLines = 1, overflow = TextOverflow.Ellipsis)
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
                            tripId = filing.trip?.id,
                            tripTitle = filing.trip?.title,
                            outingId = filing.outing?.id,
                            outingTitle = filing.outing?.title,
                            collectionId = filing.collection?.id,
                            collectionTitle = filing.collection?.title,
                            takenMs = it.takenMs,
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
private fun QueueScreen(baseUrl: String, onBack: () -> Unit, onPickMore: () -> Unit, onYouTube: (String) -> Unit) {
    val context = LocalContext.current
    val queue by UploadQueue.get(context).state.collectAsState()
    val lines = queue.items
    val failed = lines.count { it.state == ItemState.FAILED }
    val finished = lines.count { it.state == ItemState.SENT || it.state == ItemState.ALREADY || it.state == ItemState.LINKED }

    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onBack) { Text("‹ Back") }
                Heading("Uploads")
                Text(summaryOf(queue) ?: "Nothing has been chosen yet.")
                if (lines.any { it.state == ItemState.WAITING || it.state == ItemState.SENDING }) {
                    Text("These keep sending with the app closed, whenever the phone has a connection. The album then takes a moment to read each one.")
                }
                WifiOnlySwitch()
                Button(onClick = onPickMore) { Text("Choose more") }
                if (failed > 0) {
                    OutlinedButton(onClick = { UploadQueue.get(context).retryFailed(); UploadWorker.kick(context) }) { Text("Try the $failed again") }
                }
                if (finished > 0) {
                    OutlinedButton(onClick = { UploadQueue.get(context).clearFinished() }) { Text("Clear the $finished that are done") }
                }
            }
        }
        // What needs attention first, then what is moving, then what is over with.
        val order = listOf(ItemState.TOO_BIG, ItemState.FAILED, ItemState.SENDING, ItemState.WAITING, ItemState.SENT, ItemState.ALREADY, ItemState.LINKED)
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
                            ItemState.TOO_BIG -> "Too big for the album" to Rust
                            ItemState.LINKED -> "Linked from YouTube" to Good
                        }
                        Text(label, color = color, fontWeight = FontWeight.Bold)
                        Helpers.filingLine(Filing(item.tripTitle?.let { t -> Trip("", t, "", "") }, item.outingTitle?.let { t -> Outing("", t, "", "", "") }, item.collectionTitle?.let { t -> CollectionName("", t) }), byDate = false).takeIf { item.tripTitle != null || item.outingTitle != null || item.collectionTitle != null }?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        item.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    }
                    val photoId = item.photoId
                    if (item.state == ItemState.TOO_BIG) {
                        OutlinedButton(onClick = { onYouTube(item.id) }) { Text("Use YouTube") }
                    } else if (photoId != null) {
                        OutlinedButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$baseUrl/photos/$photoId"))) }) { Text("Open") }
                    }
                }
            }
        }
    }
}

/**
 * For a video the album will not keep: the steps to put it on YouTube, and a box for the link that comes back. The
 * link is added to the album on the video's own day, and on the trip that was chosen for it.
 */
@Composable
private fun YouTubeScreen(api: AlbumApi, itemId: String, onBack: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val queue by UploadQueue.get(context).state.collectAsState()
    val item = queue.items.firstOrNull { it.id == itemId }
    var link by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        OutlinedButton(onClick = onBack) { Text("‹ Back") }
        if (item == null || item.state != ItemState.TOO_BIG) {
            // Dealt with (or cleared) while this screen was open.
            Text("There is nothing more to do for this video.")
            return@Column
        }
        Heading("Too big for the album")
        Text(item.name, fontWeight = FontWeight.Bold)
        item.message?.let { Text(it) }
        Text("The album keeps short clips itself. A longer video lives on YouTube, and the album shows it from there:")
        Text("1. Tap the button below and choose YouTube.")
        Text("2. Set who can see it to Unlisted. Then only people with the link, which is to say the album, can watch it.")
        Text("3. Upload it. When YouTube has finished, open the video there, tap Share, then Copy link.")
        Text("4. Come back here, paste the link, and add it.")
        OutlinedButton(
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                val send = Intent(Intent.ACTION_SEND)
                    .setType("video/*")
                    .putExtra(Intent.EXTRA_STREAM, Uri.parse(item.uri))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                try {
                    context.startActivity(Intent.createChooser(send, "Put this video on YouTube"))
                } catch (e: Exception) {
                    problem = "This phone could not hand the video to YouTube. Open the YouTube app and upload it from there."
                }
            },
        ) { Text("Put this video on YouTube") }
        OutlinedTextField(
            value = link,
            onValueChange = { link = it },
            label = { Text("YouTube link") },
            placeholder = { Text("https://youtu.be/…") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedButton(
            onClick = {
                val clip = context.getSystemService(android.content.ClipboardManager::class.java)?.primaryClip
                val pasted = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(context)?.toString() else null
                if (pasted.isNullOrBlank()) problem = "Nothing has been copied yet. In YouTube, tap Share, then Copy link." else link = pasted.trim()
            },
        ) { Text("Paste the copied link") }
        Text(
            item.tripTitle?.let { "It will go on the trip $it." } ?: "The album will file it by the day it was filmed.",
            style = MaterialTheme.typography.bodySmall,
        )
        problem?.let { Text(it, color = Rust) }
        if (busy) {
            Progress("Adding it to the album…")
        } else {
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = link.isNotBlank(),
                onClick = {
                    busy = true
                    problem = null
                    val day = Helpers.dayString(item.takenMs ?: item.lastModifiedMs ?: System.currentTimeMillis(), ZoneId.systemDefault())
                    scope.launch {
                        try {
                            val added = withContext(Dispatchers.IO) { api.addVideo(link, day, item.tripId) }
                            UploadQueue.get(context).finish(item.id, ItemState.LINKED, added.title.ifBlank { null }, added.photoId)
                            onBack()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            problem = if (e is AlbumException) e.message else "Could not reach the album: ${e.message ?: e.javaClass.simpleName}"
                            busy = false
                        }
                    }
                },
            ) { Text("Add the link to the album") }
            OutlinedButton(onClick = { UploadQueue.get(context).remove(item.id); onBack() }) { Text("Leave this video out") }
        }
    }
}

/** The album's trips and collections, to pick one to show on a television. */
@Composable
private fun ShowsScreen(api: AlbumApi, onBack: () -> Unit, onChoose: (Show) -> Unit) {
    var problem by remember { mutableStateOf<String?>(null) }
    val shows by produceState<List<Show>?>(initialValue = null, api) {
        value = try {
            withContext(Dispatchers.IO) { api.shows("trip") + api.shows("collection") }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = if (e is AlbumException) e.message else "Could not reach the album: ${e.message ?: e.javaClass.simpleName}"
            emptyList()
        }
    }
    val list = shows
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onBack) { Text("‹ Back") }
                Heading("Slideshow on a TV")
                Text("Choose what to show. The TV shows the pictures; this phone is the remote control.")
                problem?.let { Text(it, color = Rust) }
                Button(modifier = Modifier.fillMaxWidth(), onClick = { onChoose(Show(Helpers.ALL, "", "Search the whole album", "", 0)) }) {
                    Text("Search the whole album")
                }
                Text("Find a person, a theme or a year across every trip, and show what matches.", style = MaterialTheme.typography.bodySmall)
                if (list == null) Progress("Fetching the album's trips and collections…")
                if (list != null && list.isEmpty() && problem == null) Text("The album has no trips or collections yet.")
            }
        }
        if (list != null) {
            for (kind in listOf("trip", "collection")) {
                val ofKind = list.filter { it.kind == kind }
                if (ofKind.isEmpty()) continue
                item(key = "heading-$kind") {
                    Text(if (kind == "trip") "Trips" else "Collections", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
                }
                listItems(ofKind, key = { "${it.kind}-${it.slug}" }) { show ->
                    Card(Modifier.fillMaxWidth().clickable { onChoose(show) }) {
                        Column(Modifier.padding(12.dp)) {
                            Text(show.title, fontWeight = FontWeight.Bold)
                            val count = if (show.items == 1) "1 item" else "${show.items} items"
                            Text(if (show.detail.isEmpty()) count else "${show.detail} · $count", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
        }
    }
}

/** One line of the remote's grid: a day's heading, or one photo. */
private sealed interface GridLine {
    data class Day(val day: SlideDay) : GridLine
    data class Photo(val slide: Slide) : GridLine
}

/**
 * The remote control for a slideshow on a television, and the slideshow itself laid out by day as the album's
 * timeline is. The photo on the television is outlined; tapping any other puts that one up. Days can be picked and
 * the show narrowed as on the website, and Next and Previous then move through what is left. The television
 * fetches each picture itself, from an address the album signed for it; the phone only says which.
 */
@Composable
private fun RemoteScreen(api: AlbumApi, baseUrl: String, show: Show, onBack: () -> Unit) {
    val context = LocalContext.current
    val caster = remember { Caster(context) }
    val screens by caster.screens.collectAsState()
    val connected by caster.connected.collectAsState()
    val castProblem by caster.problem.collectAsState()
    var problem by remember { mutableStateOf<String?>(null) }
    // The slideshow itself is `ShowPlayer`'s, so it goes on with this screen in the background.
    val playing by ShowPlayer.playing.collectAsState()
    val seconds by ShowPlayer.seconds.collectAsState()
    val shuffle by ShowPlayer.shuffle.collectAsState()
    // Another phone holding the same television's remote may be the one moving the slideshow on.
    val elsewhere by ShowPlayer.elsewhere.collectAsState()
    // The family's videos among the photos, where the television can play them (the album's own page).
    var clips by remember { mutableStateOf(Caster.OWN_PAGE) }
    // Asking every trip and collection at once, not only the one that was opened. The whole album always is.
    var everywhere by remember { mutableStateOf(show.kind == Helpers.ALL) }
    var filter by remember { mutableStateOf(ShowFilter()) }
    var picked by remember { mutableStateOf(setOf<String>()) }
    // The whole album is only ever shown narrowed, so it opens on the questions.
    var narrowing by remember { mutableStateOf(show.kind == Helpers.ALL) }
    var loaded by remember { mutableStateOf<SlideShow?>(null) }
    var loading by remember { mutableStateOf(true) }
    // Music under the photos, where this build casts to the album's own page (see `Caster.OWN_PAGE`).
    var choosingMusic by remember { mutableStateOf(false) }
    val songs by ShowPlayer.songs.collectAsState()
    val tvMusic by caster.music.collectAsState()

    // Looking for televisions only while this screen is open; leaving it ends the show on the television too.
    androidx.compose.runtime.DisposableEffect(caster) {
        caster.start()
        ShowPlayer.attach(context, caster, baseUrl, show.title)
        onDispose {
            ShowPlayer.end()
            caster.leave()
            caster.stop()
        }
    }

    val kind = if (everywhere) Helpers.ALL else show.kind
    LaunchedEffect(show, kind, filter, clips) {
        loading = true
        problem = null
        try {
            val got = withContext(Dispatchers.IO) { api.slideShow(kind, show.slug, filter, clips) }
            loaded = got
            // The same photo with its fresh address, or the first one when nothing is up yet.
            ShowPlayer.adopt(got.slides)
            val there = got.slides.map { it.dayKey ?: Helpers.UNDATED }.toSet()
            picked = picked.filter { it in there }.toSet()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = if (e is AlbumException) e.message else "Could not reach the album: ${e.message ?: e.javaClass.simpleName}"
        }
        loading = false
    }

    val all = loaded?.slides ?: emptyList()
    val arranged = loaded?.arranged == true
    val days = remember(all, arranged) { Helpers.slideDays(all, arranged) }
    val shownDays = remember(days, picked) { Helpers.pickedDays(days, picked) }
    val shown = remember(shownDays) { shownDays.flatMap { it.slides } }
    val lines: List<GridLine> = remember(shownDays) {
        buildList<GridLine> {
            for (day in shownDays) {
                if (day.label.isNotEmpty()) add(GridLine.Day(day))
                for (photo in day.slides) add(GridLine.Photo(photo))
            }
        }
    }
    // What is on the television, or will be once one is chosen. Narrowing the list does not change it.
    val slide = ShowPlayer.current.collectAsState().value
    val place = shown.indexOfFirst { it.id == slide?.id }
    val grid = rememberLazyGridState()

    // Next, Back and playing by itself move through what is listed here; the player puts each photo on the television.
    LaunchedEffect(shown) { ShowPlayer.list(shown) }
    // The grid follows the television: when the photo on it is off the screen, the grid is brought to it.
    LaunchedEffect(slide?.id, lines) {
        val at = lines.indexOfFirst { it is GridLine.Photo && it.slide.id == slide?.id }
        if (at >= 0 && grid.layoutInfo.visibleItemsInfo.none { it.index == at }) grid.animateScrollToItem(maxOf(0, at - 3))
    }

    if (narrowing) {
        BackHandler { narrowing = false }
        NarrowScreen(
            filter = filter,
            choices = loaded?.choices ?: SlideChoices(),
            everywhere = everywhere,
            canStayHere = show.kind != Helpers.ALL,
            hereTitle = show.title,
            onClose = { narrowing = false },
            onApply = { asked, all ->
                everywhere = all
                // An outing belongs to one trip, so it is not asked of the whole album.
                filter = if (all) asked.copy(activityId = null) else asked
                narrowing = false
            },
        )
        return
    }

    if (choosingMusic) {
        BackHandler { choosingMusic = false }
        MusicScreen(api, playing = songs, onClose = { choosingMusic = false }, onPlay = { chosen ->
            ShowPlayer.setMusic(chosen)
            choosingMusic = false
        })
        return
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = onBack) { Text("‹ Back") }
            Text(show.title, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        problem?.let { Text(it, color = Rust) }
        if (!caster.available) {
            Text("This phone cannot cast: it needs Google Play services, which it does not have or which are out of date.", color = Rust)
        } else if (connected == null) {
            Text("Choose a TV", fontWeight = FontWeight.Bold)
            castProblem?.let { Text(it, color = Rust) }
            if (screens.isEmpty()) {
                Text("Looking for TVs… The TV needs Chromecast or Google TV, to be switched on, and to be on the same Wi-Fi as this phone.", style = MaterialTheme.typography.bodySmall)
            }
            for (tv in screens) {
                Button(modifier = Modifier.fillMaxWidth(), onClick = { caster.connect(tv.id) }) { Text(tv.name) }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Showing on $connected", color = Good, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                OutlinedButton(onClick = { ShowPlayer.stopShow() }) { Text("Stop") }
            }
            if (Caster.OWN_PAGE) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(Helpers.musicLine(songs, tvMusic?.index, tvMusic?.playing), style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    if (songs.isNotEmpty()) {
                        if (tvMusic?.playing == false) OutlinedButton(onClick = { ShowPlayer.resumeMusic() }) { Text("▶") } else OutlinedButton(onClick = { ShowPlayer.pauseMusic() }) { Text("❚❚") }
                        if (songs.size > 1) OutlinedButton(onClick = { ShowPlayer.nextSong() }) { Text("Next song") }
                    }
                    OutlinedButton(onClick = { choosingMusic = true }) { Text("Music") }
                }
            }
        }

        if (slide != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(96.dp).background(Color(0xFFE6E9EE))) {
                    // A photo another phone put up, from a slideshow this one has not opened, may come without its small picture.
                    if (slide.thumb.isNotEmpty()) AlbumPicture(api, slide.thumb, Modifier.fillMaxSize())
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        when {
                            place >= 0 -> "${place + 1} of ${shown.size}"
                            connected != null -> "On the TV, but not in the list below"
                            else -> "First up, but not in the list below"
                        },
                        fontWeight = FontWeight.Bold,
                    )
                    (slide.title ?: slide.caption)?.let { Text((if (slide.video != null) "▶ Video: " else "") + it, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    listOfNotNull(slide.day, slide.place).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        // Always there once there is something to show, so the remote never loses its buttons; with no television
        // chosen yet they move the outline, and the television picks up from there.
        if (shown.isNotEmpty()) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(modifier = Modifier.weight(1f).height(56.dp), onClick = { ShowPlayer.step(-1) }) { Text("‹ Back") }
                Button(modifier = Modifier.weight(1.3f).height(56.dp), onClick = { ShowPlayer.setPlaying(!(playing || elsewhere)) }) { Text(if (playing || elsewhere) "❚❚ Pause" else "▶ Play") }
                OutlinedButton(modifier = Modifier.weight(1f).height(56.dp), onClick = { ShowPlayer.step(1) }) { Text("Next ›") }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (elsewhere && !playing) "Another phone is playing this slideshow. Pause stops it; Back and Next still work."
                    else if (playing && connected == null) "Will play once a TV is chosen: a new photo every $seconds seconds."
                    else if (playing) "Playing by itself: a new photo every $seconds seconds. It keeps going with the app closed." else "Play moves on by itself every $seconds seconds.",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(onClick = { ShowPlayer.setSeconds(Helpers.nextPace(seconds)) }) { Text("Change speed") }
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (shuffle) "Shuffle is on: Next and Play pick photos in a mixed-up order." else "Shuffle: mix up the order.",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                Switch(checked = shuffle, onCheckedChange = { ShowPlayer.setShuffle(it) })
            }
            if (Caster.OWN_PAGE) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (clips) "Videos are included: each plays through, then the slideshow moves on." else "Videos: play the family's clips among the photos.",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f),
                    )
                    Switch(checked = clips, onCheckedChange = { clips = it })
                }
            }
        }

        if (loaded != null) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { narrowing = true }) { Text(if (filter.active) "Search and narrow ✓" else "Search and narrow") }
                Text(
                    when {
                        loading -> "Fetching…"
                        everywhere -> Helpers.shownLine(shown.size, shown.size) + if (all.size >= 2000) ", the first 2,000 that match" else ""
                        else -> Helpers.shownLine(shown.size, loaded?.total ?: shown.size)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                if (filter.active || picked.isNotEmpty()) {
                    OutlinedButton(onClick = { filter = ShowFilter(); picked = emptySet() }) { Text("Clear") }
                }
            }
            if (days.size > 1) {
                // Tap a day to see only that day; tap more to add them. Next and Previous then stay inside them.
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    DayChip("All days", picked.isEmpty()) { picked = emptySet() }
                    for (day in days) {
                        DayChip("${day.label} (${day.slides.size})", day.key in picked) {
                            picked = if (day.key in picked) picked - day.key else picked + day.key
                        }
                    }
                }
            }
        }

        when {
            loaded == null && problem == null -> Box(Modifier.weight(1f).fillMaxWidth().padding(20.dp)) { Progress("Fetching the slideshow…") }
            loaded == null -> Spacer(Modifier.weight(1f))
            all.isEmpty() -> Text(
                if (everywhere && !filter.active) "Tap Search and narrow to choose words, a person or a year, and the photos that match become the slideshow."
                else if (filter.active) "No photos here match that. Try fewer words, or tap Clear."
                else "There are no photos here to show yet. A slideshow shows photos only, not videos.",
                modifier = Modifier.weight(1f),
            )
            else -> LazyVerticalGrid(
                columns = GridCells.Fixed(4),
                state = grid,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                items(
                    lines,
                    key = { if (it is GridLine.Photo) it.slide.id else "day:" + (it as GridLine.Day).day.key },
                    span = { if (it is GridLine.Day) GridItemSpan(maxLineSpan) else GridItemSpan(1) },
                ) { line ->
                    when (line) {
                        is GridLine.Day -> Text(
                            "${line.day.label} · ${Helpers.shownLine(line.day.slides.size, line.day.slides.size)}",
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(top = 10.dp, bottom = 2.dp),
                        )
                        is GridLine.Photo -> {
                            val onTv = line.slide.id == slide?.id
                            Box(
                                Modifier
                                    .aspectRatio(1f)
                                    .background(Color(0xFFE6E9EE))
                                    .then(if (onTv) Modifier.border(4.dp, Rust) else Modifier)
                                    .clickable { ShowPlayer.show(line.slide) },
                            ) {
                                AlbumPicture(api, line.slide.thumb, Modifier.fillMaxSize(), ContentScale.Crop)
                                if (onTv) {
                                    Text(
                                        if (connected != null) "On TV" else "First",
                                        color = Color.White,
                                        style = MaterialTheme.typography.labelSmall,
                                        modifier = Modifier.align(Alignment.BottomStart).background(Rust).padding(horizontal = 4.dp, vertical = 1.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A day in the row of days: filled when it is picked. */
@Composable
private fun DayChip(label: String, chosen: Boolean, onClick: () -> Unit) {
    Text(
        label,
        color = if (chosen) Color.White else Navy,
        fontWeight = if (chosen) FontWeight.Bold else FontWeight.Normal,
        modifier = Modifier
            .background(if (chosen) Navy else Color(0xFFE6E9EE))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    )
}

/**
 * The questions the album's timeline can be asked, for a slideshow: words, who uploaded it, who is in it, and which
 * part of the trip. Nothing changes until "Show these photos" is tapped.
 */
@Composable
private fun NarrowScreen(
    filter: ShowFilter,
    choices: SlideChoices,
    everywhere: Boolean,
    /** False for the whole-album search, which has no one trip or collection to stay in. */
    canStayHere: Boolean,
    hereTitle: String,
    onClose: () -> Unit,
    onApply: (ShowFilter, Boolean) -> Unit,
) {
    var draft by remember { mutableStateOf(filter) }
    var all by remember { mutableStateOf(everywhere) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        OutlinedButton(onClick = onClose) { Text("‹ Back") }
        Heading("Search and narrow")
        OutlinedTextField(
            value = draft.words,
            onValueChange = { draft = draft.copy(words = it.take(200)) },
            label = { Text("Words to look for") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (canStayHere) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Search every trip and collection", fontWeight = FontWeight.Bold)
                    Text(
                        if (all) "Looking through the whole album. It needs words, a person or a year to go on."
                        else "Off: looking only in $hereTitle.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Switch(checked = all, onCheckedChange = { all = it })
            }
        }
        Button(modifier = Modifier.fillMaxWidth(), onClick = { onApply(draft.copy(words = draft.words.trim()), all) }) { Text("Show these photos") }
        if (draft.active) {
            OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = { draft = ShowFilter() }) { Text("Clear everything") }
        }
        OutlinedTextField(
            value = draft.year?.toString() ?: "",
            onValueChange = { typed -> draft = draft.copy(year = typed.filter { it.isDigit() }.take(4).toIntOrNull()) },
            label = { Text("Year, such as 2019 (optional)") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        if (choices.people.isNotEmpty() || choices.pets.isNotEmpty()) {
            Text("Who is in it", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
            Text("Choose several for the photos they are all in.", style = MaterialTheme.typography.bodySmall)
            for (person in choices.people + choices.pets) {
                val on = person.id in draft.personIds
                // The album answers for up to ten names at once.
                TripLine(person.label, "", on) {
                    draft = draft.copy(personIds = if (on) draft.personIds - person.id else if (draft.personIds.size < 10) draft.personIds + person.id else draft.personIds)
                }
            }
        }
        if (choices.activities.isNotEmpty() && !all) {
            Text("Part of the trip", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
            TripLine("Any activity", "", draft.activityId == null) { draft = draft.copy(activityId = null) }
            for (activity in choices.activities) {
                TripLine(activity.label, "", draft.activityId == activity.id) { draft = draft.copy(activityId = activity.id) }
            }
        }
        if (choices.members.size > 1) {
            Text("Uploaded by", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
            TripLine("Anyone", "", draft.uploaderId == null) { draft = draft.copy(uploaderId = null) }
            for (member in choices.members) {
                TripLine(member.label, "", draft.uploaderId == member.id) { draft = draft.copy(uploaderId = member.id) }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/**
 * Choosing the music the television plays under the photos, from the songs the family has added on the website.
 * `playing` is what it has been asked to play already.
 */
@Composable
private fun MusicScreen(api: AlbumApi, playing: List<Song>, onClose: () -> Unit, onPlay: (List<Song>) -> Unit) {
    var songs by remember { mutableStateOf<List<Song>?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var chosen by remember { mutableStateOf(playing.map { it.id }.toSet()) }
    var mix by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        try {
            val got = withContext(Dispatchers.IO) { api.songs() }
            songs = got
            // With nothing playing yet, everything starts ticked: most often the whole list is what is wanted.
            if (playing.isEmpty()) chosen = got.map { it.id }.toSet()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            problem = if (e is AlbumException) e.message else "Could not reach the album: ${e.message ?: e.javaClass.simpleName}"
        }
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        OutlinedButton(onClick = onClose) { Text("‹ Back") }
        Heading("Music for the slideshow")
        Text("The TV plays these under the photos, one after another, and starts again at the end. Add songs on the album's website, under Music.", style = MaterialTheme.typography.bodySmall)
        problem?.let { Text(it, color = Rust) }
        val all = songs
        when {
            all == null && problem == null -> Progress("Fetching the songs…")
            all == null -> {}
            all.isEmpty() -> Text("There are no songs in the album yet. Open the album's website on a computer, choose Music, and add some.")
            else -> {
                val picked = all.filter { it.id in chosen }
                Button(modifier = Modifier.fillMaxWidth(), enabled = picked.isNotEmpty(), onClick = { onPlay(if (mix) picked.shuffled() else picked) }) {
                    Text(if (picked.size == 1) "Play this song on the TV" else "Play these ${picked.size} songs on the TV")
                }
                if (playing.isNotEmpty()) {
                    OutlinedButton(modifier = Modifier.fillMaxWidth(), onClick = { onPlay(emptyList()) }) { Text("Stop the music") }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("Mix up the order", modifier = Modifier.weight(1f))
                    Switch(checked = mix, onCheckedChange = { mix = it })
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { chosen = all.map { it.id }.toSet() }) { Text("Tick all") }
                    OutlinedButton(onClick = { chosen = emptySet() }) { Text("Tick none") }
                }
                for (song in all) {
                    val on = song.id in chosen
                    TripLine(song.title, "", on) { chosen = if (on) chosen - song.id else chosen + song.id }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** The album's small pictures already fetched, so scrolling back up a grid does not fetch them again. */
private val pictures = object : android.util.LruCache<String, Bitmap>(24 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
}

/** One of the album's own pictures, fetched as this member. */
@Composable
internal fun AlbumPicture(api: AlbumApi, path: String, modifier: Modifier = Modifier, scale: ContentScale = ContentScale.Fit) {
    val bitmap by produceState<Bitmap?>(initialValue = pictures.get(path), path) {
        value = pictures.get(path) ?: withContext(Dispatchers.IO) {
            try {
                val bytes = api.bytes(path)
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.also { pictures.put(path, it) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            }
        }
    }
    bitmap?.let { Image(it.asImageBitmap(), contentDescription = null, contentScale = scale, modifier = modifier) }
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
        OutlinedButton(onClick = onBack) { Text("‹ Back") }
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
internal fun Progress(text: String) {
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
