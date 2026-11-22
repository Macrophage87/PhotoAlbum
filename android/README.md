# Family Album for Android

The album's phone app. This is milestone 1 of the plan: a small build that proves the one thing the whole app
depends on, which is that a photo sent from a phone arrives with its location intact.

## What this build does

1. Signs in through the album's own website (see "Signing in").
2. Lets you pick a photo or video three ways: from the app's own library view, with Android's photo picker, and
   with Android's file chooser.
3. Shows what Android handed over: whether it gave the original file, and whether a location is inside it.
4. Sends the file to the album unchanged and reports where the album placed it and how it knew.

Android treats each way of picking differently. The photo picker blanks the location out; the library view keeps
it only with the "location in photos" permission. The result card says "Passed" when the album read the place from
the file itself.

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
