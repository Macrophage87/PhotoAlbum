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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Where the app is. Milestone 1 has three places and no need of a navigation library. */
private sealed interface Screen {
    data object Setup : Screen
    data object Home : Screen
    data class Item(val uri: Uri, val origin: Origin) : Screen
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val store = TokenStore(applicationContext)
        setContent {
            AlbumTheme {
                Surface(Modifier.fillMaxSize().safeDrawingPadding()) { App(store) }
            }
        }
    }
}

@Composable
private fun App(store: TokenStore) {
    var signIn by remember { mutableStateOf(store.read()) }
    var member by remember { mutableStateOf<Member?>(null) }
    var screen by remember { mutableStateOf<Screen>(if (signIn == null) Screen.Setup else Screen.Home) }

    val current = signIn
    if (current == null || screen == Screen.Setup) {
        SetupScreen(
            onSignedIn = { saved, who ->
                store.save(saved)
                signIn = saved
                member = who
                screen = Screen.Home
            },
        )
        return
    }
    val api = remember(current) { AlbumApi(current.baseUrl, current.token) }
    val signOut = {
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
        else -> HomeScreen(
            api = api,
            baseUrl = current.baseUrl,
            member = member,
            onMember = { member = it },
            onPick = { uri, origin -> screen = Screen.Item(uri, origin) },
            onSignOut = signOut,
        )
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, color = Navy)
}

@Composable
private fun SetupScreen(onSignedIn: (TokenStore.SignIn, Member) -> Unit) {
    var address by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Heading("Family Album")
        Text("This early build signs in with a token made on the album's server. Paste it once; it stays on this phone.")
        OutlinedTextField(
            value = address,
            onValueChange = { address = it },
            label = { Text("Album address") },
            placeholder = { Text("album.example.com") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Sign-in token") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        problem?.let { Text(it, color = Rust) }
        Button(
            enabled = !busy,
            onClick = {
                val baseUrl = Helpers.normalizeBaseUrl(address)
                val pasted = token.trim()
                if (baseUrl == null) {
                    problem = "That does not look like the album's address. It should be like album.example.com (https only)."
                } else if (pasted.isEmpty()) {
                    problem = "Paste the sign-in token."
                } else {
                    busy = true
                    problem = null
                    scope.launch {
                        try {
                            val who = withContext(Dispatchers.IO) { AlbumApi(baseUrl, pasted).me() }
                            onSignedIn(TokenStore.SignIn(baseUrl, pasted), who)
                        } catch (e: AlbumException) {
                            problem = e.message
                        } catch (e: Exception) {
                            problem = "Could not reach the album: ${e.message ?: e.javaClass.simpleName}"
                        } finally {
                            busy = false
                        }
                    }
                }
            },
        ) { Text(if (busy) "Checking…" else "Sign in") }
    }
}

@Composable
private fun HomeScreen(
    api: AlbumApi,
    baseUrl: String,
    member: Member?,
    onMember: (Member) -> Unit,
    onPick: (Uri, Origin) -> Unit,
    onSignOut: () -> Unit,
) {
    val context = LocalContext.current
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
                Text("Pick something to send. Each way of picking is tested separately, because Android treats them differently.")
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
