package io.clutch.mobile

import android.content.Context
import java.io.File

/**
 * The Node engine (nodejs-mobile), started once for the whole app lifetime.
 * The shell only sets the stage — every path decision the host JS makes is
 * plain Node reading os.homedir():
 *   HOME   = filesDir  → ~/.clutch/{settings.json,tunnel.log,bundles}, bridge.port
 *   TMPDIR = cacheDir  → anything os.tmpdir()-based (N2)
 * The JS project is deleted and re-copied from assets on every start, so an
 * app upgrade can never run against stale host files; the engine boots from
 * filesDir/nodejs-project/index.js (scripts/sync-android-host.sh assembles
 * that asset).
 */
object NodeEngine {
    init {
        System.loadLibrary("native-lib")
    }

    @Volatile
    private var started = false

    /** Implemented in cpp/native-lib.cpp: setenv + node::Start on a pthread. */
    external fun startNodeWithArguments(args: Array<String>, home: String, tmp: String): Int

    @Synchronized
    fun ensureStarted(ctx: Context) {
        if (started) return
        val project = copyProject(ctx)
        Thread({
            val code = startNodeWithArguments(
                arrayOf(File(project, "index.js").absolutePath),
                ctx.filesDir.absolutePath, // N2: HOME
                ctx.cacheDir.absolutePath, // N2: TMPDIR
            )
            // node::Start only returns on engine failure; surface it where adb looks
            android.util.Log.e("clutch", "node engine exited with code $code")
        }, "clutch-node").start()
        started = true
    }

    private fun copyProject(ctx: Context): File {
        val target = File(ctx.filesDir, "nodejs-project")
        target.deleteRecursively()
        target.mkdirs()
        copyAssetDir(ctx, "nodejs-project", target)
        return target
    }

    private fun copyAssetDir(ctx: Context, assetPath: String, target: File) {
        val children = ctx.assets.list(assetPath)
        if (children.isNullOrEmpty()) {
            ctx.assets.open(assetPath).use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            }
            return
        }
        target.mkdirs()
        for (child in children) copyAssetDir(ctx, "$assetPath/$child", File(target, child))
    }
}
