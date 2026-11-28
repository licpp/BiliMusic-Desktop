package app.bilimusic.player

import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.nio.file.Files
import java.io.File

class ApkUpdateInstallerTest {
    @Test fun sameVersionUpdateMustMatchTheOfferedBuild() {
        val signers = setOf("key")
        fun check(installed: Long, candidate: Long) =
            ApkUpdateInstaller.validateIdentity("phone", "phone", installed, candidate, "0.4.0", "0.4.0", signers, signers, 40001)
        check(30700, 40001)
        check(40000, 40001)
        assertThrows(IllegalArgumentException::class.java) { check(40000, 40002) }
        assertThrows(IllegalArgumentException::class.java) { check(40001, 40001) }
    }
    @Test fun rejectsOtherEditionOlderVersionAndDifferentSigner() {
        fun check(pkg: String = "app.bilimusic.mobile", code: Long = 200, signers: Set<String> = setOf("key"), name: String = "0.4.0") =
            ApkUpdateInstaller.validateIdentity("app.bilimusic.mobile", pkg, 100, code, "0.4.0", name, setOf("key"), signers)
        check()
        for (action in listOf({ check(pkg="app.bilimusic.large") }, { check(code=100) }, { check(signers=setOf("other")) }, { check(signers=emptySet()) }, { check(name="0.3.0") })) {
            try { action(); fail("Must reject invalid package") } catch (_: IllegalArgumentException) { }
        }
    }
    @Test fun distinguishesMissingSigningInformationFromADifferentCertificate() {
        fun check(candidate: Set<String>) =
            ApkUpdateInstaller.validateIdentity("car", "car", 40501, 40602, "0.4.6", "0.4.6", setOf("key"), candidate)
        assertEquals("无法读取应用签名，请从官网下载并手动安装",
            assertThrows(IllegalArgumentException::class.java) { check(emptySet()) }.message)
        assertEquals("安装包签名与当前应用不一致",
            assertThrows(IllegalArgumentException::class.java) { check(setOf("other")) }.message)
    }
    @Test fun onlyAcceptsNonemptyApkInOwnCache() {
        val cache = Files.createTempDirectory("apk-test").toFile()
        try {
            val folder = File(cache, "updates").apply { mkdirs() }
            val apk = File(folder, "update.apk").apply { writeText("apk") }
            assertEquals(apk.canonicalFile, ApkUpdateInstaller.checkedFile(cache, apk.path))
            for (file in listOf(File(cache, "outside.apk").apply { writeText("apk") }, File(folder, "empty.apk").apply { createNewFile() }, File(folder, "wrong.zip").apply { writeText("apk") })) {
                try { ApkUpdateInstaller.checkedFile(cache, file.path); fail("Must reject invalid path") } catch (_: IllegalArgumentException) { }
            }
        } finally { cache.deleteRecursively() }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28, 29], manifest = Config.NONE)
class ApkUpdateArchiveSigningTest {
    @Suppress("DEPRECATION")
    @Test fun olderAndroidCanPopulateOnlyLegacyArchiveSignatures() {
        assertEquals(PackageManager.GET_SIGNATURES or PackageManager.GET_SIGNING_CERTIFICATES, ApkUpdateInstaller.signingFlags())
        val signature = Signature(byteArrayOf(1, 2, 3))
        val archive = PackageInfo().apply { signatures = arrayOf(signature) }
        assertEquals(setOf(signature.toCharsString()), ApkUpdateInstaller.signers(archive))
        assertTrue(ApkUpdateInstaller.signers(PackageInfo()).isEmpty())
    }
}
