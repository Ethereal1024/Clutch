package io.clutch.mobile

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
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
    private val assetLoader = WebViewAssetLoader.Builder()
        .setDomain("appassets.androidplatform.net")
        .addPathHandler("/ui/", WebViewAssetLoader.AssetsPathHandler(this))
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

        webView = WebView(this)
        setContentView(webView)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
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

    private fun showEngineError() {
        webView.loadData(
            "<meta charset='utf-8'><body style='font-family:sans-serif;padding:2em'>" +
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
    }
}
