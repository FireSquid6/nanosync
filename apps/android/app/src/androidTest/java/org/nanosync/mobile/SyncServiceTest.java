package org.nanosync.mobile;

import android.app.Service;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class SyncServiceTest {
    @Test public void processDeathDoesNotRequestAnUnpromptedForegroundRestart() {
        SyncService service = new SyncService();
        assertEquals(Service.START_NOT_STICKY, service.onStartCommand(null, 0, 1));
        assertNull(service.onBind(null));
    }
}
