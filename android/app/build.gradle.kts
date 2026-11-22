import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

// The upload key for Google Play is never in the repository. Whoever builds a release keeps it on their own machine
// and points at it from android/keystore.properties (git-ignored): storeFile, storePassword, keyAlias, keyPassword.
// Without that file the debug build and the tests work as before, and a release bundle is built unsigned.
val keystoreFile = rootProject.file("keystore.properties")
val keystore = Properties().apply { if (keystoreFile.exists()) keystoreFile.inputStream().use { load(it) } }

// Where the album lives. It is built into the app so nobody has to type it, and kept out of the repository: pass
// -PalbumUrl=https://…, or set ALBUM_URL, or put albumUrl=… in keystore.properties. Left out, the app asks for it.
val albumUrl: String = listOf(findProperty("albumUrl") as String?, System.getenv("ALBUM_URL"), keystore.getProperty("albumUrl"))
    .firstOrNull { !it.isNullOrBlank() }?.trim() ?: ""

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.cieply.album"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.cieply.album"
        // Android 10: the first version with MediaStore.setRequireOriginal, which is what keeps a photo's location.
        minSdk = 29
        targetSdk = 36
        // Play refuses an upload whose number it has seen, so each upload is built with the next one:
        // ./gradlew bundleRelease -PversionCode=2
        versionCode = (findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (findProperty("versionName") as String?) ?: "0.1.0"
        buildConfigField("String", "ALBUM_URL", "\"${albumUrl.replace("\\", "").replace("\"", "")}\"")
        // The link the album's website uses to hand a sign-in back to this app (see the manifest).
        manifestPlaceholders["appScheme"] = "familyalbum"
        buildConfigField("String", "APP_SCHEME", "\"familyalbum\"")
    }

    signingConfigs {
        // The debug key is kept in the repository on purpose, so every debug build (a laptop's or CI's) installs
        // over the last one. It signs nothing that is released.
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        if (keystoreFile.exists()) {
            create("release") {
                storeFile = file(keystore.getProperty("storeFile"))
                storePassword = keystore.getProperty("storePassword")
                keyAlias = keystore.getProperty("keyAlias")
                keyPassword = keystore.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            // Its own link, so a debug build installed beside the real one gets its own sign-ins back.
            manifestPlaceholders["appScheme"] = "familyalbum-debug"
            buildConfigField("String", "APP_SCHEME", "\"familyalbum-debug\"")
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.exifinterface:exifinterface:1.4.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
