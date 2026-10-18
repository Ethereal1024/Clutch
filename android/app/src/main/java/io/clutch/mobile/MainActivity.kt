package io.clutch.mobile

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.KeyEvent
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.File

/**
 * The whole native UI: a WebView over assets/ui, plus the three behaviors the
 * desktop shell owns (docs/android/02 §3) — external links leave via
 * ACTION_VIEW, back = history back, singleTask = single instance. Everything
 * else (sessions, tunnel, events) is loopback HTTP between ui/bridge-shim.js
 * and the Node engine, invisible from here.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView

    // The render layer keeps a normal https origin so localStorage (settings
    // truth, stored connections, degrade markers) behaves exactly as on the PC
    // (§3: https://appassets.androidplatform.net/ui/…).
    // AssetsPathHandler resolves the request's remaining path against the
    // assets ROOT: with the bare /ui/ registration it looks for "index.html"
    // at the root and misses assets/ui/. Delegate with the prefix restored:
    // request /ui/index.html → suffix "index.html" → asset "ui/index.html".
    private val uiAssets = WebViewAssetLoader.AssetsPathHandler(this)

    private val assetLoader = WebViewAssetLoader.Builder()
        .setDomain("appassets.androidplatform.net")
        .addPathHandler("/ui/") { path -> uiAssets.handle("ui/$path") }
        .build()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // N5 (M3): engine + tunnel live in a foreground service so they
        // survive the activity being backgrounded/destroyed. Notification
        // permission first — on API 33+ a denied POST_NOTIFICATIONS does not
        // stop the service, it just hides the mandatory notification the
        // user needs to find their way back to a runaway tunnel.
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }
        startTunnelService()

        // engine first: the page's first clutchApi call needs the bridge up
        // (idempotent — the service runs the same call)
        NodeEngine.ensureStarted(applicationContext)

        // the theme paints the window clutch_bg, and the WebView paints itself
        // the same colour: between setContentView and the page's first paint
        // the surface would otherwise be the platform's white, a visible flash
        // under a near-black UI
        webView = WebView(this)
        webView.setBackgroundColor(getColor(R.color.clutch_bg))
        setContentView(webView)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // an app is not a web page (device report: a stray two finger
            // touch zoomed the whole UI, and it stayed zoomed because the
            // visual viewport magnifies the laid out page). supportZoom
            // defaults to TRUE and covers the pinch and the double tap alike;
            // it does not touch setTextZoom, so the font scale is unchanged.
            // The app's own pinch is pure JavaScript (ui/js/diagram-viewer.js
            // transforms .dv-stage from pointer events, and .dv-stage already
            // declares touch-action: none), so it cannot be affected by this.
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // appassets = the app itself, 127.0.0.1 = the bridge/forwarded
                // APIs (kept in-WebView; cleartext there is N6's config);
                // anything else is a link the model printed → external browser,
                // matching the desktop openExternal / will-navigate policy.
                val host = request.url.host ?: return false
                if (host == "appassets.androidplatform.net" ||
                    host == "127.0.0.1" ||
                    host == "localhost"
                ) {
                    return false
                }
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        loadWhenBridgeReady()
    }

    /**
     * Poll filesDir/bridge.port — android-host.js writes it (content: the
     * port) the moment the loopback bridge listens — then load the render
     * layer with the endpoint injected as ?bridge=…, which ui/bridge-shim.js
     * reads. Same readiness contract tests/bridge-server.test.js asserts.
     */
    private fun loadWhenBridgeReady() {
        val marker = File(filesDir, "bridge.port")
        val deadline = System.currentTimeMillis() + BRIDGE_TIMEOUT_MS
        fun poll() {
            val port = if (marker.isFile) marker.readText().trim().takeIf { it.isNotEmpty() } else null
            when {
                port != null -> webView.loadUrl(
                    "https://appassets.androidplatform.net/ui/index.html" +
                        "?bridge=http://127.0.0.1:$port/"
                )

                System.currentTimeMillis() > deadline -> showEngineError()
                else -> webView.postDelayed({ poll() }, POLL_INTERVAL_MS)
            }
        }
        poll()
    }

    /**
     * N5: start the foreground service that owns the engine. startForeground-
     * Service exists from API 26; on 24/25 a plain start is the contract (the
     * service still calls startForeground itself, which is legal there).
     */
    private fun startTunnelService() {
        val intent = Intent(this, TunnelService::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    /**
     * M4: the screen-off half of the "it only reconnects once I open the app"
     * report. A foreground service keeps the PROCESS alive, not the PROCESSOR:
     * with the device idle Android suspends network access and ignores wake locks
     * (TunnelService holds one either way), so the engine can keep its ladder
     * armed and still not dial. The battery-optimization exemption is what lifts
     * that — and asking for it is an ACTIVITY's job: background activity starts
     * are blocked from API 29, so the service could not show it even if it knew
     * to. Asked once per install, and only when the engine's own marker says a
     * tunnel is actually wanted, so a user who never connected is never nagged
     * about battery settings.
     */
    override fun onResume() {
        super.onResume()
        offerBatteryExemption()
    }

    private fun offerBatteryExemption() {
        if (isFinishing || batteryExemptionAsked()) return
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (power.isIgnoringBatteryOptimizations(packageName)) return
        // "does this user want a tunnel" is the engine's answer — the same one-word
        // file the service polls — never this screen's guess from "the app is open"
        val wanted = try {
            val marker = File(filesDir, TUNNEL_STATE_MARKER)
            marker.isFile && marker.readText().trim() == "up"
        } catch (e: Exception) {
            false
        }
        if (!wanted) return
        markBatteryExemptionAsked() // once: "not now" is an answer too
        AlertDialog.Builder(this)
            .setTitle(R.string.battery_title)
            .setMessage(R.string.battery_message)
            .setPositiveButton(R.string.battery_action) { _, _ -> requestBatteryExemption() }
            .setNegativeButton(R.string.battery_later, null)
            .show()
    }

    private fun requestBatteryExemption() {
        // the direct request is the ONE screen that grants the exemption, and it
        // needs REQUEST_IGNORE_BATTERY_OPTIMIZATIONS in the manifest (declared:
        // a side-loaded build with no store policy to weigh). A device that will
        // not answer it falls back to the settings list, where the user does the
        // same thing by hand — a dead end is the one outcome to avoid.
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:$packageName"))
        val opened = try {
            startActivity(direct)
            true
        } catch (e: Exception) {
            false
        }
        if (opened) return
        try {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (e: Exception) {
            /* no such settings screen: nothing left to offer */
        }
    }

    private fun batteryExemptionAsked(): Boolean =
        getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_BATTERY_ASKED, false)

    private fun markBatteryExemptionAsked() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putBoolean(PREF_BATTERY_ASKED, true).apply()
    }

    private fun showEngineError() {
        // the bare loadData page inherits the default white background, which
        // under a #0F0F10 shell reads as "the app crashed into a web page"
        webView.loadData(
            "<meta charset='utf-8'>" +
                "<body style='font-family:sans-serif;padding:2em;" +
                "background:#0F0F10;color:#F2F2F4'>" +
                "<h3>Clutch 引擎未启动</h3>" +
                "<p>诊断：<code>adb logcat -s clutch</code>；应用沙箱内 <code>filesDir/tunnel.log</code>。</p>",
            "text/html",
            "utf-8",
        )
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // back walks the app's own history first (pickers, panels); only when
        // there is none does it reach the system (exit)
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        super.onDestroy()
        webView.destroy()
        // N5 (M3): the foreground TunnelService keeps the engine (and the
        // tunnel) across activity teardown; coming back re-attaches through
        // bridge.port + the app's own self-heal.
    }

    private companion object {
        const val POLL_INTERVAL_MS = 150L
        const val BRIDGE_TIMEOUT_MS = 30_000L
        const val REQ_NOTIFICATIONS = 1
        // the engine's wake marker: android-host.js writes it, TunnelService polls
        // it, and this screen only reads it — to decide whether a battery prompt is
        // about anything the user is actually doing (filesDir == the engine's HOME)
        const val TUNNEL_STATE_MARKER = "tunnel.state"
        // install-scoped, so "once per install" survives a cold start
        const val PREFS = "clutch"
        const val PREF_BATTERY_ASKED = "battery_exemption_asked"
    }
}
