package org.nanosync.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.UserManager;

/** Boot never launches a dataSync foreground service (forbidden for modern targets). */
public final class ResumeReceiver extends BroadcastReceiver {
    public static final int RESUME_JOB_ID = 6201;

    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_USER_UNLOCKED.equals(action)) return;
        schedule(context);
    }

    public static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        scheduler.schedule(new JobInfo.Builder(RESUME_JOB_ID,
                new ComponentName(context, ResumeJobService.class))
                .setPersisted(true).setMinimumLatency(5000).setOverrideDeadline(60_000).build());
    }

    /** A job is not an exemption to FGS launch restrictions. Ask for a visible user resume. */
    public static final class ResumeJobService extends JobService {
        @Override public boolean onStartJob(JobParameters parameters) {
            if (!getSystemService(UserManager.class).isUserUnlocked()) {
                // USER_UNLOCKED schedules another attempt; do not touch encrypted state yet.
                return false;
            }
            try {
                SyncCoordinator coordinator = SyncCoordinator.forService(this);
                coordinator.resumeAfterReboot(() -> {
                    try {
                        NotificationManager manager = getSystemService(NotificationManager.class);
                        manager.createNotificationChannel(new NotificationChannel("sync-resume", "Resume sync", NotificationManager.IMPORTANCE_DEFAULT));
                        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
                        if (launch != null) manager.notify(62, new Notification.Builder(this, "sync-resume")
                                .setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("Resume Nanosync")
                                .setContentText("Open Nanosync to resume your enabled background folders.")
                                .setAutoCancel(true).setContentIntent(PendingIntent.getActivity(this, 62, launch,
                                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)).build());
                    } catch (SecurityException ignored) { /* State remains visible in UI. */ }
                });
            } catch (SecurityException ignored) { /* Notification opt-in is requested only by visible UI. */ }
            return false;
        }
        @Override public boolean onStopJob(JobParameters parameters) { return true; }
    }
}
