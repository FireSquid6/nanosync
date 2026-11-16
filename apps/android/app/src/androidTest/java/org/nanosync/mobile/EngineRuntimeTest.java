package org.nanosync.mobile;

import android.content.Context;
import android.os.Looper;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class EngineRuntimeTest {
    @Test public void insecureOriginFailsOnMainLooperNeverFinishes() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File journal = new File(context.getFilesDir(), "runtime-test-" + UUID.randomUUID());
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean onMain = new AtomicBoolean();
        AtomicInteger errors = new AtomicInteger(), successes = new AtomicInteger();
        EngineRuntime runtime = new EngineRuntime(context, journal,
            new JSONObject().put("baseUrl", "http://example.com"), new JSONObject(), false, false,
            new EngineRuntime.Listener() {
                @Override public void onEvent(JSONObject event) { }
                @Override public void onFinished(JSONObject result) { successes.incrementAndGet(); done.countDown(); }
                @Override public void onError(String message) {
                    onMain.set(Looper.myLooper() == Looper.getMainLooper()); errors.incrementAndGet(); done.countDown();
                }
            });
        try {
            runtime.start(); runtime.start();
            assertTrue(done.await(10, TimeUnit.SECONDS));
            assertTrue(onMain.get()); assertEquals(1, errors.get()); assertEquals(0, successes.get());
            assertTrue(journal.isDirectory());
        } finally { runtime.cancel(); Files.deleteIfExists(journal.toPath()); }
    }

    @Test public void cancellationPreservesJournalAndCannotRestart() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File journal = new File(context.getFilesDir(), "runtime-test-" + UUID.randomUUID());
        assertTrue(journal.mkdir());
        File checkpoint = new File(journal, "state.json");
        byte[] bytes = "{\"checkpoint\":7}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Files.write(checkpoint.toPath(), bytes);
        AtomicInteger callbacks = new AtomicInteger();
        EngineRuntime runtime = new EngineRuntime(context, journal, new JSONObject(), new JSONObject(), false, false,
            new EngineRuntime.Listener() {
                @Override public void onEvent(JSONObject value) { callbacks.incrementAndGet(); }
                @Override public void onFinished(JSONObject value) { callbacks.incrementAndGet(); }
                @Override public void onError(String message) { callbacks.incrementAndGet(); }
            });
        try {
            runtime.cancel(); runtime.start(); runtime.cancel();
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            assertEquals(0, callbacks.get());
            assertArrayEquals(bytes, Files.readAllBytes(checkpoint.toPath()));
        } finally { Files.deleteIfExists(checkpoint.toPath()); Files.deleteIfExists(journal.toPath()); }
    }
}
