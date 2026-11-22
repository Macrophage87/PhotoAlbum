package com.cieply.album

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Where the album's address and this phone's sign-in token are kept. The token is encrypted with a key that lives
 * in the phone's own keystore and cannot be copied off it, and the app is left out of backups, so a token never
 * turns up on another device.
 */
class TokenStore(context: Context) {
    private val prefs = context.getSharedPreferences("album", Context.MODE_PRIVATE)

    data class SignIn(val baseUrl: String, val token: String)

    fun read(): SignIn? {
        val baseUrl = prefs.getString(KEY_URL, null) ?: return null
        val sealed = prefs.getString(KEY_TOKEN, null) ?: return null
        return try {
            val parts = sealed.split(":")
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            SignIn(baseUrl, String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8))
        } catch (e: Exception) {
            // The key is gone (a restored phone, a cleared keystore): signing in again is the only way back.
            clear()
            null
        }
    }

    fun save(signIn: SignIn) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.doFinal(signIn.token.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString(KEY_URL, signIn.baseUrl)
            .putString(KEY_TOKEN, Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP))
            .apply()
    }

    /** A sign-in that has been asked for and not yet answered: which album, and the secret that proves it was us. */
    data class Pending(val baseUrl: String, val verifier: String)

    fun pending(): Pending? {
        val baseUrl = prefs.getString(KEY_PENDING_URL, null) ?: return null
        val verifier = prefs.getString(KEY_PENDING_VERIFIER, null) ?: return null
        return Pending(baseUrl, verifier)
    }

    fun savePending(pending: Pending) {
        prefs.edit().putString(KEY_PENDING_URL, pending.baseUrl).putString(KEY_PENDING_VERIFIER, pending.verifier).apply()
    }

    fun clearPending() {
        prefs.edit().remove(KEY_PENDING_URL).remove(KEY_PENDING_VERIFIER).apply()
    }

    fun clear() {
        prefs.edit().remove(KEY_URL).remove(KEY_TOKEN).apply()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "album-token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_URL = "baseUrl"
        const val KEY_TOKEN = "token"
        const val KEY_PENDING_URL = "pendingBaseUrl"
        const val KEY_PENDING_VERIFIER = "pendingVerifier"
    }
}
