import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val repoRoot: File = rootProject.projectDir.parentFile

// Версия — из корневого package.json (как у сервера). При выпуске её задаёт
// workflow: ./gradlew assembleRelease -Ptainik.version=0.8.0
fun appVersion(): String {
    val fromProp = (findProperty("tainik.version") as String?)?.trim()?.removePrefix("v")
    if (!fromProp.isNullOrEmpty()) return fromProp
    @Suppress("UNCHECKED_CAST")
    val pkg = JsonSlurper().parse(File(repoRoot, "package.json")) as Map<String, Any?>
    return pkg["version"] as String
}

fun versionCodeOf(v: String): Int {
    val m = Regex("""^(\d+)\.(\d+)\.(\d+)""").find(v) ?: error("Неверная версия: $v")
    val (major, minor, patch) = m.destructured
    return major.toInt() * 1_000_000 + minor.toInt() * 1_000 + patch.toInt()
}

// Адрес сервера по умолчанию: переменная окружения TAINIK_SERVER (как у десктопа)
// или -Ptainik.server=chat.example.com. Без них — сервер на компьютере разработчика,
// видимый из эмулятора Android как 10.0.2.2.
fun defaultServer(): String {
    val raw = (System.getenv("TAINIK_SERVER") ?: findProperty("tainik.server") as String? ?: "").trim()
    if (raw.isEmpty()) return "ws://10.0.2.2:8080/ws"
    var s = raw
    if (!Regex("^(wss?|https?)://", RegexOption.IGNORE_CASE).containsMatchIn(s)) s = "wss://$s"
    s = s.replaceFirst(Regex("^https:", RegexOption.IGNORE_CASE), "wss:")
        .replaceFirst(Regex("^http:", RegexOption.IGNORE_CASE), "ws:")
    val u = java.net.URI(s)
    val path = if (u.path.isNullOrEmpty() || u.path == "/") "/ws" else u.path
    return java.net.URI(u.scheme, u.userInfo, u.host, u.port, path, u.query, null).toString()
}

/** Копирует общий интерфейс (client/) и крипто-ядро (shared/) в ассеты приложения. */
abstract class PrepareWebTask : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val clientDir: DirectoryProperty

    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sharedDir: DirectoryProperty

    @get:Input
    abstract val server: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun run() {
        val out = outputDir.get().asFile
        out.deleteRecursively()
        val web = File(out, "web")
        web.mkdirs()
        clientDir.get().asFile.copyRecursively(web)
        sharedDir.get().asFile.copyRecursively(File(web, "shared"))
        File(web, "config.js").writeText(
            "// Сгенерировано сборкой Android\nexport default " +
                JsonOutput.toJson(mapOf("defaultServer" to server.get())) + ";\n"
        )
        logger.lifecycle("Тайник: сервер по умолчанию ${server.get()}")
    }
}

val prepareWeb = tasks.register<PrepareWebTask>("prepareWeb") {
    clientDir.set(File(repoRoot, "client"))
    sharedDir.set(File(repoRoot, "shared"))
    server.set(defaultServer())
}

val appVer = appVersion()
fun env(name: String): String? = System.getenv(name)?.takeIf { it.isNotBlank() }

android {
    namespace = "dev.tainik.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.tainik.android"
        minSdk = 26
        targetSdk = 36
        versionCode = versionCodeOf(appVer)
        versionName = appVer
    }

    // Ключ подписи выпусков: файл и пароли из окружения (секреты GitHub Actions).
    // Без них выпуск подписывается отладочным ключом — годится только для проверки.
    val keystore = env("TAINIK_KEYSTORE")?.let { file(it) }?.takeIf { it.exists() }
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = keystore
                storePassword = env("TAINIK_KEYSTORE_PASSWORD")
                keyAlias = env("TAINIK_KEY_ALIAS") ?: "tainik"
                keyPassword = env("TAINIK_KEY_PASSWORD") ?: env("TAINIK_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(prepareWeb, PrepareWebTask::outputDir)
    }
}
