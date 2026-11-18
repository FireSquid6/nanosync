package org.nanosync.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

/** One visible native scheduler for all independent vault runtimes; never JS timers. */
public final class SyncService extends Service {
    private static final String CHANNEL = "sync-background";
    private final Handler main = new Handler(Looper.getMainLooper());
    private SyncCoordinator coordinator;
    private boolean stopped;
    private String stopReason = "Background sync is not running. Open Nanosync to resume.";
    private final Runnable scan = new Runnable() {
        @Override public void run() {
            if (stopped) return;
            if (!coordinator.hasBackground()) { stopSelf(); return; }
            coordinator.tick();
            main.postDelayed(this, 3000);
        }
    };

    @Override public void onCreate() {
        super.onCreate();
        coordinator = SyncCoordinator.forService(this);
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Background sync", NotificationManager.IMPORTANCE_LOW));
        Notification.Builder notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("Nanosync background sync")
                .setContentText("Watching enabled folders. Android may restrict screen-off operation.").setOngoing(true);
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) notification.setContentIntent(PendingIntent.getActivity(this, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(61, notification.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(61, notification.build());
            coordinator.serviceStarted(this);
            main.post(scan);
        } catch (RuntimeException e) {
            stopped = true;
            stopReason = "Android restricted background sync. Open Nanosync to retry and check background permissions.";
            coordinator.serviceStopped(this, stopReason);
            stopSelf();
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!stopped && coordinator != null) coordinator.serviceStarted(this);
        // No automatic foreground-service restart from a background process after a kill.
        return START_NOT_STICKY;
    }

    /** Android 15 dataSync quota: cease foreground operation promptly, retain recovery journals. */
    @Override public void onTimeout(int startId, int foregroundServiceType) {
        stopped = true;
        main.removeCallbacks(scan);
        stopReason = "Android's background sync time limit was reached. Open Nanosync to resume.";
        coordinator.serviceStopped(this, stopReason);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override public void onDestroy() {
        stopped = true;
        main.removeCallbacks(scan);
        coordinator.serviceStopped(this, stopReason);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
