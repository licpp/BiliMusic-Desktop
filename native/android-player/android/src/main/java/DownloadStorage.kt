package app.bilimusic.player

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.BaseColumns
import android.provider.DocumentsContract
import android.provider.MediaStore
import app.tauri.plugin.JSObject
import java.io.File
import java.io.FileNotFoundException

/** Device-local destination grants. Audio remains in the managed library for offline playback. */
internal class DownloadStorage(private val context: Context) {
    private val resolver get() = context.contentResolver
    private val prefs get() = context.getSharedPreferences("bilimusic-downloads", Context.MODE_PRIVATE)
    private val tree get() = prefs.getString("tree", null)?.let(Uri::parse)
    private val defaultDirectory get() = "${Environment.DIRECTORY_DOWNLOADS}/BiliMusic"

    fun status(): JSObject {
        val uri = tree
        val available = if (uri == null) Build.VERSION.SDK_INT >= 29 else hasGrant(uri)
        return JSObject().put("label", if (uri == null) {
            if (available) defaultDirectory else "请选择保存文件夹"
        } else prefs.getString("label", "已选择的文件夹"))
            .put("available", available).put("custom", uri != null).put("canReset", Build.VERSION.SDK_INT >= 29)
    }

    private fun hasGrant(uri: Uri) = resolver.persistedUriPermissions.any { it.uri == uri && it.isWritePermission }

    fun pickerIntent() = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        tree?.let { putExtra(DocumentsContract.EXTRA_INITIAL_URI, it) }
    }

    fun select(uri: Uri, flags: Int) {
        require(uri.scheme == "content" && DocumentsContract.isTreeUri(uri)) { "请选择可写入的文件夹" }
        val grants = flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        require(grants and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0) { "没有获得文件夹写入权限，请重新选择" }
        val old = tree
        resolver.takePersistableUriPermission(uri, grants)
        try {
            val document = DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))
            val label = resolver.query(document, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS), null, null, null)?.use {
                check(it.moveToFirst() && it.getString(1) == DocumentsContract.Document.MIME_TYPE_DIR &&
                    it.getInt(2) and DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE != 0) { "这个文件夹无法保存歌曲，请选择其他文件夹" }
                it.getString(0)
            } ?: error("无法读取这个文件夹，请重新选择")
            check(prefs.edit().putString("tree", uri.toString()).putString("label", label).commit())
        } catch (error: Exception) {
            if (uri != old) release(uri)
            throw error
        }
        if (old != null && old != uri) release(old)
    }

    private fun release(uri: Uri) {
        try { resolver.releasePersistableUriPermission(uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION) } catch (_: Exception) { }
    }

    fun reset() {
        check(Build.VERSION.SDK_INT >= 29) { "请先选择保存文件夹" }
        val old = tree
        check(prefs.edit().clear().commit())
        old?.let(::release)
    }

    fun save(path: String, skipExisting: Boolean = false): Boolean {
        val source = File(path).canonicalFile
        val managed = File(context.applicationInfo.dataDir, "downloads").canonicalFile
        require(source.parentFile == managed && source.isFile && source.length() > 0) { "下载文件不可用" }
        val mime = when (source.extension.lowercase()) {
            "m4a" -> "audio/mp4"; "flac" -> "audio/flac"; "aac" -> "audio/aac"; "mp3" -> "audio/mpeg"
            else -> error("不支持的音频格式")
        }
        val folder = tree
        val destination: Uri
        if (folder != null) {
            check(hasGrant(folder)) { "保存文件夹的授权已失效，请在设置中重新选择下载目录" }
            if (skipExisting && hasDocument(folder, source)) return false
            val parent = DocumentsContract.buildDocumentUriUsingTree(folder, DocumentsContract.getTreeDocumentId(folder))
            destination = DocumentsContract.createDocument(resolver, parent, mime, source.name)
                ?: error("无法创建音乐文件，请检查文件夹权限与剩余空间")
        } else {
            check(Build.VERSION.SDK_INT >= 29) { "请先在设置中选择下载目录" }
            if (skipExisting && hasMediaStoreFile(source)) return false
            destination = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, source.name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, defaultDirectory)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }) ?: error("无法保存到下载文件夹，请检查剩余空间")
        }
        try {
            resolver.openOutputStream(destination, "w")?.use { output -> source.inputStream().use { it.copyTo(output) } }
                ?: error("无法写入音乐文件")
            if (folder == null && Build.VERSION.SDK_INT >= 29) {
                check(resolver.update(destination, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null) > 0)
            }
        } catch (error: Exception) {
            try {
                if (folder != null) DocumentsContract.deleteDocument(resolver, destination)
                else resolver.delete(destination, null, null)
            } catch (_: Exception) { }
            throw error
        }
        return true
    }

    private fun hasDocument(folder: Uri, source: File): Boolean {
        val parentId = DocumentsContract.getTreeDocumentId(folder)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(folder, parentId)
        val columns = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_MIME_TYPE)
        return resolver.query(children, columns, null, null, null)?.use { rows ->
            val size = source.length()
            while (rows.moveToNext()) {
                val name = rows.getString(1) ?: continue
                if (rows.getString(3) == DocumentsContract.Document.MIME_TYPE_DIR ||
                    !matchesExportName(name, source) || (!rows.isNull(2) && rows.getLong(2) != size)) continue
                val document = DocumentsContract.buildDocumentUriUsingTree(folder, rows.getString(0))
                if (hasFile(document, size)) return@use true
            }
            false
        } ?: error("无法读取保存文件夹，请检查权限")
    }

    @androidx.annotation.RequiresApi(29)
    private fun hasMediaStoreFile(source: File): Boolean {
        val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
        val columns = arrayOf(BaseColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME)
        val size = source.length()
        val selection = "${MediaStore.MediaColumns.RELATIVE_PATH} IN (?, ?) AND " +
            "${MediaStore.MediaColumns.OWNER_PACKAGE_NAME} = ? AND ${MediaStore.MediaColumns.IS_PENDING} = 0 AND " +
            "(${MediaStore.MediaColumns.DISPLAY_NAME} = ? OR ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ? ESCAPE '#')"
        val prefix = source.nameWithoutExtension.replace("#", "##").replace("%", "#%").replace("_", "#_")
        val args = arrayOf(defaultDirectory, "$defaultDirectory/", context.packageName, source.name,
            "$prefix (%).${source.extension}")
        return resolver.query(collection, columns, selection, args, null)?.use { rows ->
            while (rows.moveToNext()) {
                val name = rows.getString(1) ?: continue
                if (matchesExportName(name, source) && hasFile(ContentUris.withAppendedId(collection, rows.getLong(0)), size)) {
                    return@use true
                }
            }
            false
        } ?: error("无法读取下载目录，请检查权限")
    }

    // Android providers can append a number if the original name is already in use.
    private fun matchesExportName(name: String, source: File): Boolean {
        if (name == source.name) return true
        val prefix = "${source.nameWithoutExtension} ("
        val suffix = ").${source.extension}"
        if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false
        val number = name.removePrefix(prefix).removeSuffix(suffix)
        return number.isNotEmpty() && number.all { it in '0'..'9' }
    }

    private fun hasFile(uri: Uri, expectedSize: Long): Boolean = try {
        resolver.openAssetFileDescriptor(uri, "r")?.use { file ->
            val size = file.length
            if (size >= 0) size == expectedSize else file.createInputStream().use { it.read() >= 0 }
        } ?: false
    } catch (_: FileNotFoundException) {
        false
    }
}
