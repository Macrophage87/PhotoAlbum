package com.cieply.album

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight

val Navy = Color(0xFF1F3A5F)
val Rust = Color(0xFFD2552B)
val Good = Color(0xFF1E6B3A)

/**
 * Atkinson Hyperlegible, drawn by the Braille Institute so that letters which are easily confused (I, l, 1; O, 0)
 * are told apart at a glance. Bundled rather than downloaded, so it is there on the first screen. It has two
 * weights, so anything asked for heavier than medium is drawn in its bold.
 */
private val Atkinson = FontFamily(
    Font(R.font.atkinson_hyperlegible_regular, FontWeight.Normal),
    Font(R.font.atkinson_hyperlegible_italic, FontWeight.Normal, FontStyle.Italic),
    Font(R.font.atkinson_hyperlegible_bold, FontWeight.Bold),
)

private val AlbumTypography = Typography().let { base ->
    Typography(
        displayLarge = base.displayLarge.copy(fontFamily = Atkinson),
        displayMedium = base.displayMedium.copy(fontFamily = Atkinson),
        displaySmall = base.displaySmall.copy(fontFamily = Atkinson),
        headlineLarge = base.headlineLarge.copy(fontFamily = Atkinson),
        headlineMedium = base.headlineMedium.copy(fontFamily = Atkinson),
        headlineSmall = base.headlineSmall.copy(fontFamily = Atkinson),
        titleLarge = base.titleLarge.copy(fontFamily = Atkinson),
        titleMedium = base.titleMedium.copy(fontFamily = Atkinson),
        titleSmall = base.titleSmall.copy(fontFamily = Atkinson),
        bodyLarge = base.bodyLarge.copy(fontFamily = Atkinson),
        bodyMedium = base.bodyMedium.copy(fontFamily = Atkinson),
        bodySmall = base.bodySmall.copy(fontFamily = Atkinson),
        labelLarge = base.labelLarge.copy(fontFamily = Atkinson),
        labelMedium = base.labelMedium.copy(fontFamily = Atkinson),
        labelSmall = base.labelSmall.copy(fontFamily = Atkinson),
    )
}

@Composable
fun AlbumTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = lightColorScheme(primary = Navy, secondary = Rust),
        typography = AlbumTypography,
        content = content,
    )
}
