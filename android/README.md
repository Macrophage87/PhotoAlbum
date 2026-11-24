# Family Album for Android

The album's phone app. Its job is to get photos and videos from a phone into the album as the original files,
with their location intact.

## What this build does

1. Signs in through the album's own website (see "Signing in").
2. **Upload photos and videos** shows the phone's library by day. Tap to choose, or select a whole day, then send.
   What the album already has from this phone is ticked.
3. What was chosen goes into a queue kept on the phone (`UploadQueue`) and is sent in the background by
   `UploadWorker`, with the app open or closed, whenever there is a connection. Before sending a file the app
   asks the album whether it already holds it (by SHA-256), so nothing crosses the network twice.
4. The queue screen shows each file as waiting, sending, sent, already in the album, or not sent with the reason.
   Limits come from the album, not from the app.
5. Before sending, a trip can be chosen from the album's own list (`GET /api/v1/trips`). Left alone, the album
   files each one by the date it was taken, as it does for the website.
6. A video too big or too long for the album is not a dead end: its line offers "Use YouTube", which walks through
   putting it on YouTube as Unlisted and takes the link back (`POST /api/v1/videos`), on the video's own day and
   the trip that was chosen.
7. A quiet notification shows how many are left and how it ended. It is posted by the ordinary background job, not
   a foreground service, so sending is the same with notifications refused.
8. "Send on Wi-Fi only" (home and queue screens) makes the job wait for an unmetered connection.
9. **Show a slideshow on a TV** lists the album's trips and collections, finds Chromecast and Google TV screens on
   the Wi-Fi, and casts the chosen slideshow. The phone is the remote: Previous, Next, and "Play by itself". The
   television fetches each picture itself from an address the album signs for that one picture for a few hours
   (`GET /api/v1/album/slideshow`, `src/lib/cast/link.ts`), using the receiver every Chromecast already has, so
   there is no receiver app to register. The list of screens is drawn by the app (`Caster`), not by Google's
   dialog, which would need an AppCompat theme.
10. The remote lays the slideshow out by day, as the album's timeline does, with the photo on the TV outlined.
    Tapping a photo puts it on the TV. Days can be picked from the row of days, and **Search and narrow** asks the
    same questions as the website (words, who is in it, part of the trip, who uploaded it, year); Next, Previous
    and "Play by itself" then stay inside what is left. **Search the whole album** makes a slideshow from every
    photo that matches, across all trips (`?all=1`, up to 2,000), and the same switch is inside any slideshow's
    "Search and narrow". **Play** between Back and Next moves on by itself; "Change speed" picks 5, 10, 20 or 30
    seconds. A **Shuffle** switch mixes the order.
11. The slideshow keeps going with the app in the background or the screen off (`ShowPlayer`, `ShowService`): a
    notification with Back, Play or Pause, Next and Stop stays up while a TV is connected. It is a foreground
    service of the media-playback kind and holds a wake lock only while playing by itself.
12. Music under the slideshow. Google's built-in cast player shows a picture or plays a song, never both, so the
    album has a page of its own for the television (the website's `/cast/receiver`), which does both. The app
    uses it when the build names its Cast application ID (`CAST_APP_ID` in `app/build.gradle.kts`, from Google's
    Cast SDK Developer Console, where the page's address is registered); until then it casts as before and shows
    no music controls. With it, the remote has a Music button to choose from the songs added on the website's
    Music page, and says which song is on. The phone and the page talk on `urn:x-cast:com.cieply.album`.
13. The rest of what the album's own page allows. Each slide is sent with its day, place and the people in it (the
    caption), where it was taken (a small map), the day to announce when the day changes (a title card), and the
    next slide's address so the television fetches it ahead. The family's clips are among the photos (a Videos
    switch on the remote): the television plays each through and says when it has ended, and the slideshow then
    moves on. Several phones can hold one television's remote: the page tells them all what is on it and which
    phone is moving it on, so each shows the same and only one phone's clock runs (`ShowPlayer.heard`). A phone
    that connects to a television already showing something follows it rather than replacing it, and leaving the
    remote ends the show only when no other phone is connected.

Files are read with `MediaStore.setRequireOriginal`, which needs the "location in photos" permission; without it
the app refuses to send rather than send photos with their place blanked out.

### Testing one file

The first milestone's test screen is still on the home screen. It picks one file three ways (the app's library
view, Android's photo picker, Android's file chooser), shows what Android handed over, sends it, and reports where
the album placed it. Measured on a Galaxy S26 Ultra: the library view and the file chooser hand over the original
with its location; the photo picker does not, which is why the app does not use it.

## Signing in

The app has no sign-in of its own. Tapping Sign in opens the album's website, where the member signs in by emailed
link as always and taps "Connect this phone"; the page then hands them back to the app. What the phone keeps
afterwards is a token of its own, listed under Your account on the website, where any one phone can be signed out.

The hand-back is a link (`familyalbum://connect?code=...`). The code in it is good once, for ten minutes, and only
together with a secret that never leaves the app that asked, so another app claiming the link gains nothing.

The album's address is built into the app, from `-PalbumUrl=https://...`, the `ALBUM_URL` environment variable, or
an `albumUrl=` line in `keystore.properties`. A build without one asks for the address on the sign-in screen.

`scripts/device-token.ts` on the server can still make, list and revoke tokens by hand, for the admin.

## Trying it

1. Install a build: the debug APK from Actions → Android (`family-album-debug-apk`), or the app from Play's
   internal testing track.
2. Open it and tap Sign in. Finish in the browser and tap "Back to the Family Album app".
3. Allow access when asked, then send one photo each way and compare the result cards. Worth trying as well:
   answer "Select photos" instead of "Allow all", and send a short video.

## Building

`./gradlew assembleDebug` and `./gradlew testDebugUnitTest`, with JDK 17 or newer and the Android SDK (platform 36).
Opening this folder in Android Studio does both.

`debug.keystore` is committed on purpose so every debug build installs over the last. It signs nothing released;
the Play upload key is never kept in this repository.

## Type

The app is set in Atkinson Hyperlegible (Braille Institute), chosen for the older readers in the family. The font
files are bundled under `app/src/main/res/font/`; their licence (SIL Open Font License 1.1) is in
`app/src/main/ATKINSON-HYPERLEGIBLE-OFL.txt`.

## A bundle for Google Play

Play takes an `.aab` signed with an upload key. Google keeps the real signing key (Play App Signing), so a lost
upload key can be replaced through Play Console; it is still a secret and is never committed.

1. Once, make an upload key somewhere outside the repository:

   ```
   keytool -genkeypair -v -keystore ~/keys/family-album-upload.jks -alias upload \
     -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Once, write `android/keystore.properties` (git-ignored):

   ```
   storeFile=/home/you/keys/family-album-upload.jks
   storePassword=...
   keyAlias=upload
   keyPassword=...
   ```

3. For each upload, build with the next version number:

   ```
   ./gradlew bundleRelease -PversionCode=2 -PversionName=0.1.1
   ```

   The bundle is `app/build/outputs/bundle/release/app-release.aab`. Its id is `com.cieply.album`, which is
   permanent once Play has seen it.

## Automatic delivery

`.github/workflows/android-release.yml` builds a signed bundle and puts it on Play's internal testing track on
every merge to `main` that touches `android/`. It needs, once:

1. The first bundle uploaded by hand in Play Console (the API cannot create an app or its first release).
2. A Google Cloud service account with the "Google Play Android Developer API" enabled, and a JSON key for it.
3. That account invited in Play Console (Users and permissions) with "Release to testing tracks" on this app.
4. Four repository secrets: `PLAY_SERVICE_ACCOUNT_JSON`, `ANDROID_UPLOAD_KEYSTORE_BASE64`
   (`base64 -w0` of the keystore), `ANDROID_UPLOAD_KEYSTORE_PASSWORD` and `ALBUM_URL`.

Without the secrets the workflow skips and stays green. Version numbers come from the run number, so they only go up.
