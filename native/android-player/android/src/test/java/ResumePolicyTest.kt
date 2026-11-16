package app.bilimusic.player

import org.junit.Assert.assertEquals
import org.junit.Test

class ResumePolicyTest {
    @Test fun totalMediaDurationOverridesMissingAndStaleListMetadata() {
        val policy = AutomaticResumePolicy().apply { thresholdSeconds = 600.0 }
        assertEquals(85.0, playbackStartPosition(85.0, 1800.0, policy), 0.0)
        policy.durationSeconds = 1800.0
        assertEquals(0.0, playbackStartPosition(85.0, 300.0, policy), 0.0)
        assertEquals(0.0, playbackStartPosition(85.0, 599.0, policy), 0.0)
        assertEquals(85.0, playbackStartPosition(85.0, 600.0, policy), 0.0)
        assertEquals(85.0, playbackStartPosition(85.0, 601.0, policy), 0.0)
        assertEquals(85.0, playbackStartPosition(85.0, 0.0, policy), 0.0)
    }

    @Test fun disabledAutomaticCollectionsRestartButExplicitStartsRemainIndependent() {
        val policy = AutomaticResumePolicy().apply { enabled = false }
        assertEquals(0.0, playbackStartPosition(85.0, 1800.0, policy), 0.0)
        policy.collection = true
        assertEquals(0.0, playbackStartPosition(85.0, 120.0, policy), 0.0)
        assertEquals(85.0, playbackStartPosition(85.0, 120.0, null), 0.0)
        policy.enabled = true; policy.collection = false
        assertEquals(0.0, playbackStartPosition(119.0, 120.0, policy), 0.0)
        assertEquals(0.0, playbackStartPosition(Double.NaN, 120.0, policy), 0.0)
    }
}
