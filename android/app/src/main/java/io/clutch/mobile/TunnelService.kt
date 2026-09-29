package io.clutch.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

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
 * and nothing else: every tunnel decision stays in the JS host (docs/android/
 * 02 §3 — the native shell is a stage, not a second brain).
 */
class TunnelService : Service() {

    override fun onCreate() {
        super.onCreate()
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
        // START_STICKY: restart when the system reclaims us mid-tunnel
        return START_STICKY
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

    override fun onBind(intent: Intent?): IBinder? = null

    private companion object {
        const val CHANNEL_ID = "tunnel"
        const val NOTIFICATION_ID = 1
    }
}
