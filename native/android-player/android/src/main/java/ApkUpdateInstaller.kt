package app.bilimusic.player

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

// Manifest merging keys providers by class name. Keep OTA cache access separate
// from Tauri's general FileProvider and its own authority/path configuration.
class ApkUpdateProvider : FileProvider()

/** Rust supplies a verified download; Android independently checks application identity. */
internal object ApkUpdateInstaller {
    internal fun checkedFile(cache: File, path: String): File {
        val folder = File(cache, "updates").canonicalFile
        val file = File(path).canonicalFile
        require(file.parentFile == folder && file.extension == "apk" && file.isFile && file.length() > 0) { "安装包缓存已失效，请重新下载" }
        return file
    }
    internal fun validateIdentity(currentPackage: String, candidatePackage: String?, currentVersion: Long,
                                  candidateVersion: Long, expectedVersion: String, version: String?,
                                  currentSigners: Set<String>, candidateSigners: Set<String>,
                                  expectedVersionCode: Long? = null) {
        require(currentPackage == candidatePackage) { "安装包与当前应用不匹配" }
        require(version == expectedVersion && candidateVersion > currentVersion &&
            (expectedVersionCode == null || candidateVersion == expectedVersionCode)) { "安装包版本不正确，请重新检查更新" }
        require(currentSigners.isNotEmpty() && candidateSigners.isNotEmpty()) { "无法读取应用签名，请从官网下载并手动安装" }
        require(currentSigners == candidateSigners) { "安装包签名与当前应用不一致" }
    }
    private fun version(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()

    @Suppress("DEPRECATION")
    internal fun signingFlags(): Int {
        // Some Android versions only collect archive certificates with GET_SIGNATURES.
        return PackageManager.GET_SIGNATURES or if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else 0
    }

    @Suppress("DEPRECATION")
    internal fun signers(info: PackageInfo): Set<String> {
        val current = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else null
        return (current?.takeIf { it.isNotEmpty() } ?: info.signatures).orEmpty().map { it.toCharsString() }.toSet()
    }
    fun prepare(activity: Activity, path: String, expectedVersion: String, expectedVersionCode: Long?): File {
        val file = checkedFile(activity.cacheDir, path)
        val flags = signingFlags()
        @Suppress("DEPRECATION") val installed = activity.packageManager.getPackageInfo(activity.packageName, flags)
        @Suppress("DEPRECATION") val candidate = activity.packageManager.getPackageArchiveInfo(file.path, flags) ?: error("无法读取安装包，请重新下载")
        validateIdentity(activity.packageName, candidate.packageName, version(installed), version(candidate), expectedVersion,
                         candidate.versionName, signers(installed), signers(candidate), expectedVersionCode)
        return file
    }
    fun launch(activity: Activity, file: File): String {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            return "permission-required"
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)
        activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        return "installer-opened"
    }
}
