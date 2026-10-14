package io.clutch.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import java.io.File

/**
 * N5 (M3): the foreground service that keeps the Node engine — and with it
 * the SSH tunnel and the loopback bridge — alive when the activity is
 * backgrounded or destroyed. targetSdk 34 freezes/caches background
 * processes aggressively; a `dataSync` foreground service is the closest
 * declared fit for a long-lived SSH tunnel (known platform limit: ~6h of
 * dataSync FGS per 24h window — an M4 concern, not a correctness one).
 *
 * Responsibilities are deliberately tiny:
 *   1. paint the mandatory notification (channel "tunnel"),
 *   2. boot the engine via NodeEngine.ensureStarted (idempotent — a sticky
 *      restart after the system killed the process re-boots it the same way
 *      MainActivity's first call did),
 *   3. M4: hold the CPU awake while — and only while — the engine's own marker
 *      file under HOME says a tunnel is wanted,
 * and nothing else: every tunnel decision stays in the JS host (docs/android/
 * 02 §3 — the native shell is a stage, not a second brain). The marker is that
 * rule applied to the one thing a service can do and the engine cannot: the
 * engine writes "up"/"down" (android/host/android-host.js, off the reconnect
 * ladder's own state) and this service only ever READS it. A service that
 * guessed "up" from "an engine is running" would pin the CPU for a phone that
 * never connected to anything.
 */
class TunnelService : Service() {

    private lateinit var power: PowerManager
    private lateinit var marker: File
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val handler = Handler(Looper.getMainLooper())

    // The marker poll: a stat and a read of a one-word file, then the same again
    // in two seconds. Cheap enough to run for the app's whole life, slow enough
    // that gaining or losing a lock is invisible next to the backoff it serves.
    private val watchMarker = object : Runnable {
        override fun run() {
            applyWakeState(wantsTunnel())
            handler.postDelayed(this, MARKER_POLL_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        power = getSystemService(Context.POWER_SERVICE) as PowerManager
        marker = File(filesDir, STATE_MARKER) // filesDir == HOME on the engine side (N2)
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.app_name),
                NotificationManager.IMPORTANCE_MIN, // silent presence, no heads-up
            )
            channel.setDescription("SSH tunnel and coding engine status")
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundCompat()
        // engine first, same seam MainActivity uses; the service may also be
        // entered cold via a sticky restart with no activity in the task
        NodeEngine.ensureStarted(applicationContext)
        // one watcher, however many times this command arrives (a sticky restart
        // is a second call): removeCallbacks + post is the idempotent form
        handler.removeCallbacks(watchMarker)
        handler.post(watchMarker)
        // START_STICKY: restart when the system reclaims us mid-tunnel
        return START_STICKY
    }

    /**
     * The engine's own answer, written by android-host.js off the reconnect
     * ladder's state: "up" = the user has a standing tunnel intent (a connect
     * that succeeded and was not cancelled since), anything else / no file / an
     * unreadable file = nothing is wanted. The marker can therefore only ever
     * ADD a reason to stay awake — never a reason to dial: nothing here knows
     * how to connect to anything, which keeps the "nothing dials behind the
     * user's back" rule true even with a service in the middle of it.
     */
    private fun wantsTunnel(): Boolean = try {
        marker.isFile && marker.readText().trim() == "up"
    } catch (e: Exception) {
        false
    }

    private fun applyWakeState(want: Boolean) {
        if (want) acquireWakeLocks() else releaseWakeLocks()
    }

    private fun acquireWakeLocks() {
        if (wakeLock == null) {
            val wl = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG)
            // non-reference-counted: this class acquires and releases once per
            // wanted/unwanted edge, so a miscounted reference could only leak
            wl.setReferenceCounted(false)
            wakeLock = wl
        }
        wakeLock?.let { wl ->
            if (!wl.isHeld) {
                // PARTIAL_WAKE_LOCK: the screen may go off, the processor may not —
                // the ladder's timers are the whole point, and a timer parked on a
                // suspended CPU fires whenever the phone next wakes for something
                // else, which is exactly the reported "it reconnects when I open
                // the app" symptom. Held for as long as the marker says up and
                // released the moment it does not (there is no timeout to leak).
                //
                // CAVEAT, unverified: this checkout cannot reach developer.android.com
                // and has no device, so the Doze rules below are stated from the
                // design, not from a test. Doze suspends network access and IGNORES
                // wake locks, so these two locks only hold while the device is not
                // idle — the battery-optimization exemption MainActivity asks for is
                // what lifts that, and it is why the two ship together.
                wl.acquire()
                Log.i(TAG, "[wake] CPU held: a tunnel is wanted, so the ladder may have to redial with the screen off")
            }
        }
        var lock = wifiLock
        if (lock == null) lock = createWifiLock()
        if (lock != null && !lock.isHeld) acquireWifiLock(lock)
    }

    private fun createWifiLock(): WifiManager.WifiLock? {
        val wm = getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
        val lock = wm.createWifiLock(wifiLockMode(), WAKE_TAG)
        // non-reference-counted for the same reason as the wake lock above
        lock.setReferenceCounted(false)
        wifiLock = lock
        return lock
    }

    // the paired WifiLock: the radio is what the redial dials through, and with
    // the screen off it drops into power save between beacons otherwise
    private fun acquireWifiLock(lock: WifiManager.WifiLock) {
        try {
            lock.acquire()
        } catch (e: Exception) {
            // a device without the service, or a platform that refuses the mode:
            // the wake lock above already covers the timers, so this is a note,
            // never a reason to fail the whole thing
            Log.w(TAG, "[wake] wifi lock refused: ${e.message}")
        }
    }

    @Suppress("DEPRECATION") // HIGH_PERF is the pre-Q spelling of the same request
    private fun wifiLockMode(): Int =
        if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        else WifiManager.WIFI_MODE_FULL_HIGH_PERF

    private fun releaseWakeLocks() {
        val held = (wakeLock?.isHeld == true) || (wifiLock?.isHeld == true)
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        if (held) Log.i(TAG, "[wake] CPU released: no tunnel is wanted")
    }

    private fun startForegroundCompat() {
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") // pre-26 path, minSdk 24
            Notification.Builder(this)
        }
        builder.setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.tunnel_notification_text))
            .setSmallIcon(R.drawable.ic_stat_clutch)
            .setOngoing(true)
        val notification = builder.build()

        if (Build.VERSION.SDK_INT >= 29) {
            // the 3-arg overload exists from API 29 only; the manifest pins
            // the type, this call states it for the API-34 permission check
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onDestroy() {
        // the service going away is the one moment a lock MUST be let go: a wake
        // lock that outlives its holder is a flat battery, and a sticky restart
        // re-asks the marker from scratch anyway
        handler.removeCallbacks(watchMarker)
        releaseWakeLocks()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private companion object {
        const val TAG = "TunnelService"
        const val CHANNEL_ID = "tunnel"
        const val NOTIFICATION_ID = 1
        // written by the engine (android/host/android-host.js), read here
        const val STATE_MARKER = "tunnel.state"
        // one tag for both locks: what a bugreport's dumpsys will show as ours
        const val WAKE_TAG = "clutch:tunnel"
        const val MARKER_POLL_MS = 2000L
    }
}
