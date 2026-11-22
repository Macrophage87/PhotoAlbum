# Family Album for Android

The album's phone app. This is milestone 1 of the plan: a small build that proves the one thing the whole app
depends on, which is that a photo sent from a phone arrives with its location intact.

## What this build does

1. Signs in with a token made on the album's server (the six-digit email sign-in comes in milestone 2).
2. Lets you pick a photo or video three ways: from the app's own library view, with Android's photo picker, and
   with Android's file chooser.
3. Shows what Android handed over: whether it gave the original file, and whether a location is inside it.
4. Sends the file to the album unchanged and reports where the album placed it and how it knew.

Android treats each way of picking differently. The photo picker blanks the location out; the library view keeps
it only with the "location in photos" permission. The result card says "Passed" when the album read the place from
the file itself.

## Trying it

1. Make a token on the server that runs the album you want to test against (staging first):

   ```
   docker compose exec app ./node_modules/.bin/tsx scripts/device-token.ts you@example.com "Pixel 9"
   ```

   It prints the token once. `--list` shows a member's phones and `--revoke <id>` signs one out.
2. Install the debug build. GitHub builds it on every push that touches `android/`: open the run under
   Actions → Android and download `family-album-debug-apk`. It installs beside a future Play build, as
   "Family Album" with the id `com.cieply.album.debug`.
3. Open it, enter the album's address and paste the token.
4. Allow access when asked, then send one photo each way and compare the result cards. Worth trying as well:
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
