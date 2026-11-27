package app.bilimusic.player

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.MatrixCursor
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.BaseColumns
import android.provider.DocumentsContract
import android.provider.MediaStore
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.OutputStream
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28, 29, 35], manifest = Config.NONE)
class DownloadStorageTest {
    private val context get() = RuntimeEnvironment.getApplication()
    private val grants = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    private val tree = Uri.parse("content://test.downloads/tree/music")
    private lateinit var storage: DownloadStorage
    private lateinit var provider: StorageProvider
    private lateinit var source: File

    @Before fun setup() {
        context.getSharedPreferences("bilimusic-downloads", Context.MODE_PRIVATE).edit().clear().commit()
        provider = StorageProvider(context)
        provider.attachInfo(context, android.content.pm.ProviderInfo().apply { authority = "test.downloads;media" })
        ShadowContentResolver.registerProviderInternal("media", provider)
        ShadowContentResolver.registerProviderInternal("test.downloads", provider)
        storage = DownloadStorage(context)
        source = File(context.applicationInfo.dataDir, "downloads/测试歌曲.flac").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(1, 2, 3, 4)) }
    }
    @Test fun defaultDestinationIsPublicOnModernAndroidAndRequiresSelectionOnOlderAndroid() {
        assertEquals(Build.VERSION.SDK_INT >= 29, storage.status().getBoolean("available"))
        assertFalse(storage.status().getBoolean("custom"))
        if (Build.VERSION.SDK_INT < 29) {
            try { storage.save(source.path); fail("must not silently save privately") } catch (_: IllegalStateException) { }
            assertEquals(0, provider.created.size)
        }
    }
    @Test fun publicDownloadPublishesOnlyAfterAllBytesWereWritten() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        storage.save(source.path)
        assertEquals("测试歌曲.flac", provider.created.single().getAsString(MediaStore.MediaColumns.DISPLAY_NAME))
        assertEquals("audio/flac", provider.created.single().getAsString(MediaStore.MediaColumns.MIME_TYPE))
        assertEquals("Download/BiliMusic", provider.created.single().getAsString(MediaStore.MediaColumns.RELATIVE_PATH))
        assertEquals(1, provider.created.single().getAsInteger(MediaStore.MediaColumns.IS_PENDING))
        assertArrayEquals(source.readBytes(), provider.output.toByteArray())
        assertTrue(provider.published); assertTrue(provider.deleted.isEmpty())
        assertTrue(source.exists()) // Offline playback keeps its own managed copy.
    }
    @Test fun selectedFolderSurvivesRecreationAndExportsThroughTheDocumentProvider() {
        storage.select(tree, grants)
        storage = DownloadStorage(context)
        assertTrue(storage.status().getBoolean("available"))
        assertEquals("我的音乐", storage.status().getString("label"))
        storage.save(source.path)
        assertEquals("测试歌曲.flac", provider.created.single().getAsString(DocumentsContract.Document.COLUMN_DISPLAY_NAME))
        assertArrayEquals(source.readBytes(), provider.output.toByteArray())
    }
    @Test fun restoringDeletedPublicDownloadCopiesTheManagedFileAndThenSkipsIt() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        assertTrue(storage.save(source.path))
        assertFalse(storage.save(source.path, skipExisting = true))
        provider.removeExportedFile()

        storage = DownloadStorage(context)
        assertTrue(storage.save(source.path, skipExisting = true))
        assertArrayEquals(source.readBytes(), provider.output.toByteArray())
        assertFalse(storage.save(source.path, skipExisting = true))
        assertEquals(2, provider.created.size)
    }
    @Test fun restoringThroughSafUsesOnlyTheSelectedFolder() {
        storage.select(tree, grants)
        assertTrue(storage.save(source.path))
        assertFalse(storage.save(source.path, skipExisting = true))

        val other = Uri.parse("content://test.downloads/tree/other")
        storage.select(other, grants)
        assertTrue(storage.save(source.path, skipExisting = true))
        assertFalse(storage.save(source.path, skipExisting = true))
        provider.removeExportedFile()
        assertTrue(storage.save(source.path, skipExisting = true))
        assertFalse(storage.save(source.path, skipExisting = true))
        assertEquals(3, provider.created.size)
        assertArrayEquals(source.readBytes(), provider.output.toByteArray())
    }
    @Test fun revokedPermissionStopsExportWithoutFallingBackToAnotherFolder() {
        storage.select(tree, grants)
        context.contentResolver.releasePersistableUriPermission(tree, grants)
        assertFalse(storage.status().getBoolean("available"))
        try { storage.save(source.path); fail("revoked grant must fail") } catch (_: IllegalStateException) { }
        assertTrue(provider.created.isEmpty())
    }
    @Test fun failedNewSelectionKeepsThePreviouslySelectedFolder() {
        storage.select(tree, grants)
        provider.writable = false
        val other = Uri.parse("content://test.downloads/tree/other")
        try { storage.select(other, grants); fail("read-only folder must fail") } catch (_: IllegalStateException) { }
        assertTrue(storage.status().getBoolean("available"))
        assertEquals(listOf(tree), context.contentResolver.persistedUriPermissions.map { it.uri })
    }
    @Test fun readOnlyGrantIsRejected() {
        try { storage.select(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); fail("write permission required") } catch (_: IllegalArgumentException) { }
        assertFalse(storage.status().getBoolean("custom"))
    }
    @Test fun incompletePublicWriteRemovesThePartialFile() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        provider.failWrite = true
        try { storage.save(source.path); fail("write should fail") } catch (_: IOException) { }
        assertEquals(1, provider.deleted.size); assertFalse(provider.published); assertTrue(source.exists())
    }
    @Test fun incompleteDocumentWriteRemovesThePartialFile() {
        storage.select(tree, grants); provider.failWrite = true
        try { storage.save(source.path); fail("write should fail") } catch (_: IOException) { }
        assertEquals(1, provider.deleted.size); assertTrue(source.exists())
    }
    @Test fun restoringDefaultReleasesOnlyThisAppsSelectedFolderGrant() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        storage.select(tree, grants); storage.reset()
        assertFalse(storage.status().getBoolean("custom")); assertTrue(storage.status().getBoolean("available"))
        assertTrue(context.contentResolver.persistedUriPermissions.isEmpty())
    }
    @Test fun exportsRejectFilesOutsideTheManagedDownloadsDirectory() {
        val file = File(context.cacheDir, "secret.flac").apply { writeText("private") }
        try { storage.save(file.path); fail("outside path must fail") } catch (_: IllegalArgumentException) { }
        assertTrue(provider.created.isEmpty())
        val link = File(source.parentFile, "link.flac")
        java.nio.file.Files.deleteIfExists(link.toPath())
        java.nio.file.Files.createSymbolicLink(link.toPath(), file.toPath())
        try { storage.save(link.path); fail("symlink must not escape") } catch (_: IllegalArgumentException) { }
        assertTrue(provider.created.isEmpty())
    }
    @Test fun systemPickerRequestsPersistableWriteAccessWithoutAllFilesPermission() {
        val intent = storage.pickerIntent()
        assertEquals(Intent.ACTION_OPEN_DOCUMENT_TREE, intent.action)
        assertEquals(grants, intent.flags and grants)
        assertTrue(intent.flags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION != 0)
    }
}

private class StorageProvider(private val app: Context) : ContentProvider() {
    var writable = true
    var failWrite = false
    var published = false
    val created = mutableListOf<ContentValues>()
    val deleted = mutableListOf<Uri>()
    val output = ByteArrayOutputStream()
    private data class Export(val id: Int, val folder: String?, val name: String, val file: File, var size: Long = 0)
    private val exports = mutableListOf<Export>()

    fun removeExportedFile() { assertTrue(exports.last().file.delete()) }

    private fun register(uri: Uri, folder: String?, name: String): Uri {
        output.reset()
        val file = File.createTempFile("export", ".flac", app.cacheDir)
        val export = Export(created.size, folder, name, file)
        exports.add(export)
        shadowOf(app.contentResolver).registerOutputStream(uri, if (failWrite) object : OutputStream() {
            override fun write(value: Int) { throw IOException("disk full") }
        } else object : OutputStream() {
            override fun write(value: Int) { output.write(value) }
            override fun write(bytes: ByteArray, offset: Int, length: Int) { output.write(bytes, offset, length) }
            override fun close() {
                file.writeBytes(output.toByteArray())
                export.size = file.length()
            }
        })
        return uri
    }
    override fun onCreate() = true
    override fun getType(uri: Uri) = "audio/flac"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?) =
        MatrixCursor(projection!!).apply {
            if (uri.authority == "media") {
                assertEquals("Download/BiliMusic/", args!![1])
                assertEquals(app.packageName, args[2])
                for (item in exports.filter { it.folder == null }) {
                    addRow(projection.map { if (it == BaseColumns._ID) item.id else item.name })
                }
            } else if (uri.lastPathSegment == "children") {
                val folder = DocumentsContract.getTreeDocumentId(uri)
                for (item in exports.filter { it.folder == folder }) {
                    addRow(projection.map { when (it) {
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID -> "saved-${item.id}"
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME -> item.name
                        DocumentsContract.Document.COLUMN_SIZE -> item.size
                        DocumentsContract.Document.COLUMN_MIME_TYPE -> "audio/flac"
                        else -> null
                    } })
                }
            } else {
                addRow(projection.map { when (it) {
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME -> "我的音乐"
                    DocumentsContract.Document.COLUMN_MIME_TYPE -> DocumentsContract.Document.MIME_TYPE_DIR
                    DocumentsContract.Document.COLUMN_FLAGS -> if (writable) DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE else 0
                    else -> null
                } })
            }
        }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val id = uri.lastPathSegment?.removePrefix("saved-")?.toIntOrNull()
        val file = exports.firstOrNull { it.id == id }?.file ?: throw FileNotFoundException()
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri {
        created.add(ContentValues(values!!))
        val name = values.getAsString(MediaStore.MediaColumns.DISPLAY_NAME)
        val displayName = if (exports.any { it.folder == null && it.name == name }) "${name.substringBeforeLast('.')} (1).${name.substringAfterLast('.')}" else name
        return register(Uri.withAppendedPath(uri, created.size.toString()), null, displayName)
    }
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int {
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), output.toByteArray())
        published = values!!.getAsInteger(MediaStore.MediaColumns.IS_PENDING) == 0
        return 1
    }
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int { deleted.add(uri); return 1 }
    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        return when (method) {
            "android:createDocument" -> {
                val parent = extras!!.getParcelable<Uri>("uri")!!
                val name = extras.getString(DocumentsContract.Document.COLUMN_DISPLAY_NAME)!!
                created.add(ContentValues().apply {
                    put(DocumentsContract.Document.COLUMN_DISPLAY_NAME, name)
                    put(DocumentsContract.Document.COLUMN_MIME_TYPE, extras.getString(DocumentsContract.Document.COLUMN_MIME_TYPE))
                })
                val folder = DocumentsContract.getTreeDocumentId(parent)
                val document = DocumentsContract.buildDocumentUriUsingTree(parent, "saved-${created.size}")
                Bundle().apply { putParcelable("uri", register(document, folder, name)) }
            }
            "android:deleteDocument" -> { deleted.add(extras!!.getParcelable<Uri>("uri")!!); Bundle() }
            else -> error("Unexpected document operation: $method")
        }
    }
}
