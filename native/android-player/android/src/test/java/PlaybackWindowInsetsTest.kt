package app.bilimusic.player

import androidx.core.graphics.Insets
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackWindowInsetsTest {
    private val bars = Insets.of(12, 36, 8, 24)

    @Test fun tabletExtendsOnlyBehindTheStatusBarInBothPlayerStates() {
        val expected = Insets.of(12, 0, 8, 24)
        assertEquals(expected, playbackWindowMargins(bars, immersive = false, keepSystemInsets = true))
        assertEquals(expected, playbackWindowMargins(bars, immersive = true, keepSystemInsets = true))
    }

    @Test fun phoneKeepsItsExistingBrowseAndImmersiveInsets() {
        assertEquals(bars, playbackWindowMargins(bars, immersive = false, keepSystemInsets = false))
        assertEquals(Insets.NONE, playbackWindowMargins(bars, immersive = true, keepSystemInsets = false))
    }
}
