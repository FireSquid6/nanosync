package org.nanosync.mobile;

import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

/** Real-server seam. Run through build/test-android.ts, never with production credentials. */
@RunWith(AndroidJUnit4.class)
public final class EngineIntegrationTest {
    @Test public void recoveryDownloadExternalSaveAndUpload() throws Exception {
        Bundle arguments = InstrumentationRegistry.getArguments();
        String encoded = arguments.getString("fixture");
        // Normal connectedAndroidTest runs platform tests without a host fixture.
        org.junit.Assume.assumeTrue("Requires the disposable real-server fixture", encoded != null);
        JSONObject fixture = new JSONObject(new String(Base64.decode(encoded, Base64.DEFAULT), StandardCharsets.UTF_8));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        JSONObject server = fixture.getJSONObject("server");
        JSONObject vault = fixture.getJSONObject("vault");
        File root = new File(vault.getString("rootPath")).getCanonicalFile();
        vault.put("rootPath", root.getPath());
        assertTrue("Test shared folder must exist", root.isDirectory());
        File journal = new File(context.getNoBackupFilesDir(), "integration-" + vault.getString("id"));
        assertTrue(journal.isDirectory() || journal.mkdirs());

        JSONObject unlocked = run(context, journal, server, vault);
        assertTrue("Recovery must return the verified vault key", unlocked.getString("masterKeyHex").matches("[0-9a-f]{64}"));
        vault.remove("recoveryKey");
        vault.put("masterKeyHex", unlocked.getString("masterKeyHex"));
        JSONObject downloaded = run(context, journal, server, vault);
        assertTrue(downloaded.getLong("sequence") > 0);
        assertEquals("from second client\n", new String(Files.readAllBytes(new File(root, "remote.txt").toPath()), StandardCharsets.UTF_8));

        // A plain filesystem save represents any external editor, not an editor-specific API.
        Files.write(new File(root, "android.txt").toPath(), "from Android\n".getBytes(StandardCharsets.UTF_8));
        JSONObject uploaded = run(context, journal, server, vault);
        assertTrue(uploaded.getLong("sequence") >= downloaded.getLong("sequence"));
        assertEquals(0, uploaded.optInt("pendingUploads", -1));
        assertEquals(0, uploaded.optInt("pendingDownloads", -1));
    }

    private static JSONObject run(Context context, File journal, JSONObject server, JSONObject vault) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<JSONObject> result = new AtomicReference<>();
        AtomicReference<String> failure = new AtomicReference<>();
        AtomicReference<EngineRuntime> engine = new AtomicReference<>();
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> {
            try {
                EngineRuntime runtime = new EngineRuntime(context, journal, server, vault, true, false,
                    new EngineRuntime.Listener() {
                        public void onEvent(JSONObject event) { }
                        public void onFinished(JSONObject value) { result.set(value); done.countDown(); }
                        public void onError(String message) { failure.set(message); done.countDown(); }
                    });
                engine.set(runtime);
                runtime.start();
            } catch (Throwable error) {
                failure.set(error.toString());
                done.countDown();
            }
        });
        try {
            assertTrue("Android engine timed out", done.await(180, TimeUnit.SECONDS));
            assertNull("Android engine failed: " + failure.get(), failure.get());
            assertNotNull("Android engine returned no result", result.get());
            return result.get();
        } finally {
            main.post(() -> { if (engine.get() != null) engine.get().cancel(); });
        }
    }
}
