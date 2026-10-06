package dev.tainik.android

import android.Manifest
import android.content.ContentUris
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * Галерея в меню «скрепки», как в Telegram: последние фото и видео телефона прямо в приложении.
 * Список — через мост (gallery.list), превью и сами файлы страница берёт со своего же адреса:
 *   /__gallery/thumb/<id>  — уменьшенная картинка (JPEG),
 *   /__gallery/file/<id>   — файл целиком (его страница шифрует и отправляет, как выбранный вручную).
 * id — «i123» (фото) или «v456» (видео) из MediaStore. Только чтение, только с разрешения пользователя.
 */
class Gallery(private val app: TainikApp) {
    companion object {
        const val PREFIX = "/__gallery/"
        private val ID_RE = Regex("^[iv][0-9]{1,18}$")
    }

    fun permissions(): Array<String> =
        when {
            Build.VERSION.SDK_INT >= 34 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
            Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
            else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }

    private fun has(p: String) = app.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    /** "full" — вся галерея, "partial" — только выбранные пользователем (Android 14), "none". */
    fun access(): String =
        when {
            Build.VERSION.SDK_INT >= 33 && has(Manifest.permission.READ_MEDIA_IMAGES) -> "full"
            Build.VERSION.SDK_INT < 33 && has(Manifest.permission.READ_EXTERNAL_STORAGE) -> "full"
            Build.VERSION.SDK_INT >= 34 && has(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> "partial"
            else -> "none"
        }

    private fun uriOf(id: String): Uri? {
        if (!ID_RE.matches(id)) return null
        val n = id.substring(1).toLongOrNull() ?: return null
        val base = if (id[0] == 'i') MediaStore.Images.Media.EXTERNAL_CONTENT_URI else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        return ContentUris.withAppendedId(base, n)
    }

    /** Последние фото и видео (новые сначала): [{ id, kind, mime, name, size, dur, ts }]. */
    fun list(limit: Int, before: Long): String {
        val out = JSONArray()
        if (access() == "none") return out.toString()
        val files = MediaStore.Files.getContentUri("external")
        val cols = arrayOf(
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            MediaStore.Files.FileColumns.MIME_TYPE,
            MediaStore.Files.FileColumns.DISPLAY_NAME,
            MediaStore.Files.FileColumns.SIZE,
            MediaStore.Files.FileColumns.DATE_ADDED,
            MediaStore.Video.VideoColumns.DURATION,
        )
        val types = "(${MediaStore.Files.FileColumns.MEDIA_TYPE}=${MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE} OR ${MediaStore.Files.FileColumns.MEDIA_TYPE}=${MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO})"
        val sel = if (before > 0) "$types AND ${MediaStore.Files.FileColumns.DATE_ADDED} < ?" else types
        val args = if (before > 0) arrayOf(before.toString()) else null
        app.contentResolver.query(files, cols, sel, args, "${MediaStore.Files.FileColumns.DATE_ADDED} DESC")?.use { c ->
            var n = 0
            while (c.moveToNext() && n < limit.coerceIn(1, 200)) {
                val video = c.getInt(1) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                out.put(
                    JSONObject()
                        .put("id", (if (video) "v" else "i") + c.getLong(0))
                        .put("kind", if (video) "video" else "image")
                        .put("mime", c.getString(2) ?: "")
                        .put("name", c.getString(3) ?: "")
                        .put("size", c.getLong(4))
                        .put("ts", c.getLong(5))
                        .put("dur", if (video) c.getLong(6) / 1000 else 0)
                )
                n++
            }
        }
        return out.toString()
    }

    /** Запрос страницы к /__gallery/… (её собственный адрес — чужие страницы сюда не достанут). */
    fun serve(path: String, headers: Map<String, String>): WebResourceResponse {
        val parts = path.removePrefix(PREFIX).split('/')
        val uri = if (parts.size == 2) uriOf(parts[1]) else null
        if (uri == null || access() == "none") return empty(404)
        return try {
            when (parts[0]) {
                "thumb" -> {
                    val bmp = if (Build.VERSION.SDK_INT >= 29) {
                        app.contentResolver.loadThumbnail(uri, Size(320, 320), null)
                    } else {
                        @Suppress("DEPRECATION")
                        if (parts[1][0] == 'i') MediaStore.Images.Thumbnails.getThumbnail(app.contentResolver, parts[1].substring(1).toLong(), MediaStore.Images.Thumbnails.MINI_KIND, null)
                        else MediaStore.Video.Thumbnails.getThumbnail(app.contentResolver, parts[1].substring(1).toLong(), MediaStore.Video.Thumbnails.MINI_KIND, null)
                    } ?: return empty(404)
                    val buf = ByteArrayOutputStream()
                    bmp.compress(Bitmap.CompressFormat.JPEG, 80, buf)
                    ok("image/jpeg", ByteArrayInputStream(buf.toByteArray()), mapOf("Cache-Control" to "private, max-age=600"))
                }
                "file" -> {
                    val mime = app.contentResolver.getType(uri) ?: "application/octet-stream"
                    val input = app.contentResolver.openInputStream(uri) ?: return empty(404)
                    ok(mime, input, mapOf("Cache-Control" to "no-store"))
                }
                else -> empty(404)
            }
        } catch (e: Exception) {
            empty(404)
        }
    }

    private fun ok(mime: String, body: java.io.InputStream, extra: Map<String, String>) =
        WebResourceResponse(mime, null, 200, "OK", mapOf("X-Content-Type-Options" to "nosniff") + extra, body)

    private fun empty(code: Int) =
        WebResourceResponse("text/plain", "utf-8", code, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}
