package io.clutch.mobile

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Looper
import android.provider.Settings
import android.webkit.JavascriptInterface
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The one thing the render layer cannot do for itself: ask Android to install the
 * APK it just downloaded (the About pane's update button, ui/js/update-panel.js).
 *
 * Why this exists at all: the download runs in the Node engine, which has no way
 * to start an Intent — NodeEngine exposes no handle to this side, and the engine
 * deliberately knows nothing about the activity. So the page, which does have a
 * WebView around it, calls through `window.clutchShell` (registered in
 * MainActivity.onCreate) and this class turns that call into the platform's own
 * package-installer screen.
 *
 * The shape of the answer is a JSON string, not an exception: an @JavascriptInterface
 * method can only return primitives, and the page needs to tell three outcomes
 * apart —
 *
 *   {"ok":true,...}                 the installer screen is open; the user confirms
 *   {"ok":false,"needsPermission":true}  Android has not been told this app may
 *                                   install packages; the settings screen for it
 *                                   has just been opened (API 26+ only)
 *   {"ok":false,"error":"..."}      the path was not a downloaded update, the file
 *                                   is gone, or nothing could open it
 *
 * REQUEST_INSTALL_PACKAGES (AndroidManifest.xml) is necessary but NOT sufficient:
 * from API 26 the user grants "install unknown apps" per app, in Settings, and a
 * build that cannot show that screen leaves the button dead with no explanation.
 * Hence the needsPermission branch, and hence it comes back to the page: the user
 * presses Install again when they return, which is the only reliable signal that
 * the grant happened.
 *
 * Path containment is enforced here as well as in ui/update-service.js: the
 * installer only accepts a file under filesDir/updates, the same directory
 * res/xml/file_paths.xml publishes through the FileProvider. A page that named
 * any other path — a bug, or a page that is not ours — gets a refusal, not an
 * install.
 */
class UpdateInstaller(private val activity: Activity) {

    /** The directory the engine downloads into (android/host/android-host.js). */
    private val updatesDir: File get() = File(activity.filesDir, "updates")

    @JavascriptInterface
    fun installApk(path: String): String = onMainThread {
        val file = File(path)
        val root = updatesDir.canonicalFile
        val target = try {
            file.canonicalFile
        } catch (e: Exception) {
            return@onMainThread error("that is not a path this app can read")
        }
        if (!target.path.startsWith(root.path + File.separator) || !target.isFile) {
            return@onMainThread error("that file is not a downloaded update")
        }
        if (!target.name.endsWith(".apk")) {
            return@onMainThread error("that file is not an APK")
        }
        // API 26+: installing outside a store is a per-app grant the user gives in
        // Settings. Opening that screen is the only way to ask; the install itself
        // is offered again on the next press.
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            val asked = try {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                        .setData(android.net.Uri.parse("package:${activity.packageName}"))
                )
                true
            } catch (e: Exception) {
                false
            }
            return@onMainThread JSONObject()
                .put("ok", false)
                .put("needsPermission", true)
                .put(
                    "error",
                    if (asked) "Allow Clutch to install unknown apps in Settings, then press Install again."
                    else "Allow Clutch to install unknown apps in Settings, then come back and press Install again."
                )
                .toString()
        }
        // The FileProvider authority is declared per applicationId
        // (AndroidManifest.xml: ${applicationId}.updates), so a debuggable variant
        // or a renamed package cannot collide with another app's provider.
        val uri = try {
            FileProvider.getUriForFile(activity, "${activity.packageName}.updates", target)
        } catch (e: Exception) {
            return@onMainThread error("the installer could not read ${target.name}: ${e.message}")
        }
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return@onMainThread try {
            activity.startActivity(intent)
            JSONObject().put("ok", true).put("name", target.name).toString()
        } catch (e: Exception) {
            error("no installer accepted ${target.name}: ${e.message}")
        }
    }

    private fun error(message: String): String =
        JSONObject().put("ok", false).put("error", message).toString()

    /**
     * Run `block` where an Activity can be touched, and hand its answer back to the
     * JavaScript thread that asked.
     *
     * @JavascriptInterface calls arrive on a WebView-owned background thread, and
     * startActivity from there is not guaranteed to be late enough in a lifecycle
     * the platform considers valid. The latch matters: the page decides what to say
     * from the RETURN value, so returning before the Intent was attempted would
     * report success for a launch that threw.
     */
    private fun onMainThread(block: () -> String): String {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        var result: String? = null
        val done = CountDownLatch(1)
        activity.runOnUiThread {
            try {
                result = block()
            } finally {
                done.countDown()
            }
        }
        return if (done.await(5, TimeUnit.SECONDS)) {
            result ?: error("the installer gave no answer")
        } else {
            error("the installer did not answer in time")
        }
    }
}
