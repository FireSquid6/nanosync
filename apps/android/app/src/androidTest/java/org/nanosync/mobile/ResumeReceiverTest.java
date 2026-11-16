package org.nanosync.mobile;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class ResumeReceiverTest {
    @Test public void bootSchedulesPersistedJobInsteadOfStartingForegroundService() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        try {
            new ResumeReceiver().onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
            JobInfo job = scheduler.getPendingJob(ResumeReceiver.RESUME_JOB_ID);
            assertNotNull(job);
            assertTrue(job.isPersisted());
            assertEquals(ResumeReceiver.ResumeJobService.class.getName(), job.getService().getClassName());
            assertTrue(job.getMinLatencyMillis() >= 5000);
        } finally { scheduler.cancel(ResumeReceiver.RESUME_JOB_ID); }
    }
    @Test public void unrelatedBroadcastDoesNotScheduleWork() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        scheduler.cancel(ResumeReceiver.RESUME_JOB_ID);
        new ResumeReceiver().onReceive(context, new Intent("org.nanosync.UNRELATED"));
        assertNull(scheduler.getPendingJob(ResumeReceiver.RESUME_JOB_ID));
    }
}
