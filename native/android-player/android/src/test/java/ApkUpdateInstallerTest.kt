package app.bilimusic.player

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.io.File

class ApkUpdateInstallerTest {
    @Test fun rejectsOtherEditionOlderVersionAndDifferentSigner() {
        fun check(pkg: String = "app.bilimusic.mobile", code: Long = 200, signers: Set<String> = setOf("key"), name: String = "0.4.0") =
            ApkUpdateInstaller.validateIdentity("app.bilimusic.mobile", pkg, 100, code, "0.4.0", name, setOf("key"), signers)
        check()
        for (action in listOf({ check(pkg="app.bilimusic.large") }, { check(code=100) }, { check(signers=setOf("other")) }, { check(signers=emptySet()) }, { check(name="0.3.0") })) {
            try { action(); fail("Must reject invalid package") } catch (_: IllegalArgumentException) { }
        }
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
