package dev.tainik.android

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Зашифрованное хранилище «ключ → JSON» для ключей протокола, сессий и переписки.
 *
 * Каждое значение — отдельный файл, зашифрованный AES-256-GCM ключом данных; имя записи
 * входит в AAD, поэтому файлы нельзя переставить местами. Сам ключ данных зашифрован
 * мастер-ключом из Android Keystore: его байты не покидают защищённое хранилище ОС
 * (на большинстве телефонов — аппаратное). Это аналог safeStorage в десктопе.
 *
 * Записи сохраняются сразу и атомарно (AtomicFile + fsync): состояние храповика нельзя терять.
 * Вызывается из одного потока (Bridge), но методы на всякий случай синхронизированы.
 */
class SecureStore(base: File) {
    private companion object {
        const val TAG = "TainikStore"
        const val ALIAS = "tainik-store-master"
        const val GCM = "AES/GCM/NoPadding"
        const val IV = 12
    }

    private val dir = File(base, "store")
    private val cache = HashMap<String, String?>()
    private var dataKey: SecretKey? = null
    private val random = SecureRandom()

    @Synchronized
    fun get(k: String): String? {
        check(k)
        if (cache.containsKey(k)) return cache[k]
        val f = AtomicFile(fileFor(k))
        val value = if (f.baseFile.exists()) decrypt(k, f.readFully()) else null
        cache[k] = value
        return value
    }

    @Synchronized
    fun set(k: String, json: String) {
        check(k)
        val iv = ByteArray(IV).also { random.nextBytes(it) }
        val c = Cipher.getInstance(GCM)
        c.init(Cipher.ENCRYPT_MODE, key(), GCMParameterSpec(128, iv))
        c.updateAAD(k.toByteArray(Charsets.UTF_8))
        write(AtomicFile(fileFor(k)), iv + c.doFinal(json.toByteArray(Charsets.UTF_8)))
        cache[k] = json
    }

    @Synchronized
    fun del(k: String) {
        check(k)
        AtomicFile(fileFor(k)).delete()
        cache[k] = null
    }

    /** Стирает данные, но оставляет ключ (новый аккаунт зашифруется им же). */
    @Synchronized
    fun clear() {
        dir.listFiles { f -> f.name.endsWith(".v") }?.forEach { AtomicFile(it).delete() }
        cache.clear()
    }

    private fun check(k: String) {
        require(k.isNotEmpty() && k.length <= 256) { "Неверный ключ хранилища" }
    }

    private fun fileFor(k: String): File {
        val h = MessageDigest.getInstance("SHA-256").digest(k.toByteArray(Charsets.UTF_8))
        return File(dir, h.joinToString("") { "%02x".format(it) } + ".v")
    }

    private fun decrypt(k: String, blob: ByteArray): String {
        if (blob.size <= IV) throw IOException("Хранилище повреждено")
        val c = Cipher.getInstance(GCM)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob, 0, IV))
        c.updateAAD(k.toByteArray(Charsets.UTF_8))
        return try {
            String(c.doFinal(blob, IV, blob.size - IV), Charsets.UTF_8)
        } catch (e: GeneralSecurityException) {
            throw IOException("Хранилище повреждено: не удалось расшифровать запись", e)
        }
    }

    private fun write(f: AtomicFile, bytes: ByteArray) {
        dir.mkdirs()
        val out = f.startWrite()
        try {
            out.write(bytes)
            f.finishWrite(out) // fsync + переименование
        } catch (e: IOException) {
            f.failWrite(out)
            throw e
        }
    }

    private fun key(): SecretKey {
        dataKey?.let { return it }
        dir.mkdirs()
        val master = masterKey()
        var keyFile = AtomicFile(File(dir, "key.bin"))
        var k: SecretKey? = null
        if (keyFile.baseFile.exists()) {
            try {
                val b = keyFile.readFully()
                val c = Cipher.getInstance(GCM)
                c.init(Cipher.DECRYPT_MODE, master, GCMParameterSpec(128, b, 0, IV))
                k = SecretKeySpec(c.doFinal(b, IV, b.size - IV), "AES")
            } catch (e: GeneralSecurityException) {
                // Мастер-ключ пропал (сброс Keystore, восстановление из чужой копии) —
                // прочитать данные уже нельзя. Откладываем их в сторону и начинаем заново.
                Log.e(TAG, "ключ хранилища недоступен, данные перенесены в карантин", e)
                dir.renameTo(File(dir.parentFile, "store-unreadable-${System.currentTimeMillis()}"))
                dir.mkdirs()
                cache.clear()
                keyFile = AtomicFile(File(dir, "key.bin"))
            }
        }
        val result: SecretKey = k ?: run {
            val raw = ByteArray(32).also { random.nextBytes(it) }
            val c = Cipher.getInstance(GCM)
            c.init(Cipher.ENCRYPT_MODE, master)
            write(keyFile, c.iv + c.doFinal(raw))
            SecretKeySpec(raw, "AES")
        }
        dataKey = result
        return result
    }

    private fun masterKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return g.generateKey()
    }
}

/** Настройки страницы (адрес сервера, уведомления) — без шифрования, как settings.json в десктопе. */
class PageSettings(ctx: Context) {
    private val sp: SharedPreferences = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE)

    fun get(k: String): String? = sp.getString(k, null)

    fun set(k: String, json: String) {
        require(k.isNotEmpty() && k.length <= 256) { "Неверный ключ настройки" }
        sp.edit().putString(k, json).commit()
    }
}
