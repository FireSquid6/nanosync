package org.nanosync.mobile;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.UserManager;
import java.util.HashMap;
import java.util.Map;

/** Native bounded sync jobs; boot never launches a prohibited dataSync foreground service. */
public final class ResumeReceiver extends BroadcastReceiver {
    public static final int RESUME_JOB_ID = 6201;
    public static final int PERIODIC_JOB_ID = 6202;
    public static final long JOB_BUDGET_MILLIS = 120_000;

    @Override public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_USER_UNLOCKED.equals(action)) return;
        schedule(context);
    }

    public static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        ComponentName service = new ComponentName(context, ResumeJobService.class);
        // Do not replace an executing job: replacing it would revoke its live execution lease.
        if (scheduler.getPendingJob(RESUME_JOB_ID) == null) scheduler.schedule(new JobInfo.Builder(RESUME_JOB_ID, service)
                .setPersisted(true).setMinimumLatency(5000).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
        if (scheduler.getPendingJob(PERIODIC_JOB_ID) == null) scheduler.schedule(new JobInfo.Builder(PERIODIC_JOB_ID, service)
                .setPersisted(true).setPeriodic(15 * 60_000L).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).build());
    }

    /** Jobs hold only their own runtime leases; all WebView work stays on the main looper. */
    public static final class ResumeJobService extends JobService {
        private final Map<Integer, Task> tasks = new HashMap<>();
        private static final class Task {
            final Object owner = new Object();
            final JobParameters parameters;
            final SyncCoordinator coordinator;
            boolean stopped;
            Task(JobParameters parameters, SyncCoordinator coordinator) { this.parameters = parameters; this.coordinator = coordinator; }
        }
        @Override public boolean onStartJob(JobParameters parameters) {
            if (!getSystemService(UserManager.class).isUserUnlocked()) return false;
            SyncCoordinator coordinator = SyncCoordinator.forService(this);
            Task task = new Task(parameters, coordinator);
            tasks.put(parameters.getJobId(), task);
            coordinator.startJob(task.owner, JOB_BUDGET_MILLIS, () -> {
                if (tasks.get(parameters.getJobId()) == task) tasks.remove(parameters.getJobId());
                // Android has already finished a stopped job. Still retain internal ownership
                // until IO drains, but never call jobFinished on those obsolete parameters.
                if (!task.stopped) jobFinished(parameters, false);
            });
            return true;
        }
        @Override public boolean onStopJob(JobParameters parameters) {
            Task task = tasks.get(parameters.getJobId());
            if (task != null) {
                task.stopped = true;
                task.coordinator.stopJob(task.owner);
            }
            return true;
        }
        @Override public void onDestroy() {
            for (Task task : tasks.values()) { task.stopped = true; task.coordinator.stopJob(task.owner); }
            super.onDestroy();
        }
    }
}
