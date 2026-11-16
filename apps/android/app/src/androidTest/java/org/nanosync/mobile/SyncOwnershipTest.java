package org.nanosync.mobile;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;
import static org.junit.Assert.*;

/** Public command/lifecycle tests at the injected native execution boundary. No real transfers. */
@RunWith(AndroidJUnit4.class)
public final class SyncOwnershipTest {
    private static void await(BooleanSupplier condition) throws Exception {
        long until = System.currentTimeMillis() + 5000;
        while (!condition.getAsBoolean() && System.currentTimeMillis() < until) Thread.sleep(10);
        assertTrue("Timed out waiting for coordinator state", condition.getAsBoolean());
    }
    private static final class FakeRun implements SyncCoordinator.RuntimeHandle {
        final EngineRuntime.Listener listener;
        volatile boolean cancelled;
        FakeRun(EngineRuntime.Listener listener) { this.listener = listener; }
        public void start() { }
        public void cancel() { cancelled = true; } // deliberately withhold the IO-drained fence
        void drain() { listener.onError("Cancelled"); }
    }
    private static final class Fixture implements AutoCloseable {
        final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        final AppStore store = AppStore.get(context);
        final JSONObject original = store.snapshot();
        final List<String> ids = new ArrayList<>();
        final ConcurrentHashMap<String, FakeRun> runs = new ConcurrentHashMap<>();
        final SyncCoordinator coordinator;
        final java.util.concurrent.atomic.AtomicInteger cleanupFailures = new java.util.concurrent.atomic.AtomicInteger();
        Fixture(int count, long budget) throws Exception {
            JSONArray vaults = new JSONArray();
            for (int i = 0; i < count; i++) {
                String id = UUID.randomUUID().toString(); ids.add(id);
                vaults.put(new JSONObject().put("id", id).put("vaultId", UUID.randomUUID().toString())
                        .put("rootPath", context.getCacheDir().getPath() + "/" + id)
                        .put("masterKeyHex", "a".repeat(64)).put("background", true));
            }
            JSONObject server = new JSONObject().put("id", UUID.randomUUID().toString()).put("baseUrl", "https://example.com")
                    .put("token", "test-only").put("enrollmentStatus", "approved").put("vaults", vaults);
            store.update(new JSONObject().put("servers", new JSONArray().put(server)));
            coordinator = new SyncCoordinator(context, store, null, new SyncCoordinator.ExecutionEnvironment() {
                @Override void startBackgroundService(Context ignored) { }
                @Override void removeJournal(AppStore target, String id) {
                    if (cleanupFailures.getAndUpdate(value -> Math.max(0, value - 1)) > 0) throw new IllegalStateException("Temporary cleanup failure");
                    target.removeJournal(id);
                }
                @Override long budgetMillis(int previousYields) { return previousYields == 0 ? budget : 60_000; }
                @Override boolean networkAllowed(Context ignored, boolean mobile) { return true; }
                @Override File validateRoot(String path) { return new File(path); }
                @Override SyncCoordinator.RuntimeHandle create(Context c, File journal, JSONObject s, JSONObject vault,
                        boolean http, boolean override, EngineRuntime.Listener listener) {
                    FakeRun run = new FakeRun(listener); runs.put(vault.optString("id"), run); return run;
                }
            });
        }
        JSONObject vault(int index) {
            JSONArray vaults = store.snapshot().optJSONArray("servers").optJSONObject(0).optJSONArray("vaults");
            for (int i = 0; i < vaults.length(); i++) if (ids.get(index).equals(vaults.optJSONObject(i).optString("id"))) return vaults.optJSONObject(i);
            return null;
        }
        boolean tombstone(String id) {
            JSONArray pending = store.snapshot().optJSONArray("cleanupJournals");
            if (pending != null) for (int i = 0; i < pending.length(); i++) if (id.equals(pending.optString(i))) return true;
            return false;
        }
        public void close() throws Exception {
            for (String id : ids) coordinator.disconnectVault(id);
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            for (FakeRun run : runs.values()) run.drain();
            await(() -> { for (String id : ids) if (tombstone(id)) return false; return true; });
            store.update(original);
        }
    }

    @Test public void queuedManualIsInvalidatedByPauseButNewManualWhilePausedIsAllowed() throws Exception {
        try (Fixture f = new Fixture(5, 60_000)) {
            for (String id : f.ids) f.coordinator.syncNow(id, false);
            await(() -> f.runs.size() == 4 && "Queued".equals(f.vault(4).optString("status")));
            f.store.mutate(config -> { try { config.getJSONArray("servers").getJSONObject(0).getJSONArray("vaults").getJSONObject(4).put("paused", true); }
                catch (Exception e) { throw new AssertionError(e); } });
            f.coordinator.settingsChanged();
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            f.runs.get(f.ids.get(0)).listener.onError("test finish");
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            assertFalse(f.runs.containsKey(f.ids.get(4)));
            f.coordinator.syncNow(f.ids.get(4), false);
            await(() -> f.runs.containsKey(f.ids.get(4)));
            assertTrue(f.vault(4).optBoolean("paused"));
        }
    }

    @Test public void recoveryTimeoutExplainsThatRecoveryKeyMustBeEnteredAgain() throws Exception {
        try (Fixture f = new Fixture(0, 100)) {
            String serverId = f.store.snapshot().getJSONArray("servers").getJSONObject(0).getString("id");
            f.coordinator.connectVault(serverId, UUID.randomUUID().toString(), "Recovery", f.context.getCacheDir() + "/recovery", "transient-test-key");
            await(() -> f.runs.size() == 1 && f.runs.values().iterator().next().cancelled);
            String id = f.runs.keySet().iterator().next();
            assertTrue(f.store.snapshot().optString("error").contains("enter the recovery key again"));
            assertFalse(f.store.snapshot().toString().contains("transient-test-key"));
            f.runs.get(id).drain();
            await(() -> f.store.snapshot().optJSONArray("servers").optJSONObject(0).optJSONArray("vaults").length() == 0 && !f.tombstone(id));
        }
    }

    @Test public void cleanupFailureCanRetryInSameProcessWithoutDuplicateWorker() throws Exception {
        try (Fixture f = new Fixture(1, 60_000)) {
            String id = f.ids.get(0); File journal = f.store.journalDirectory(id);
            assertTrue(new File(journal, "retained-stage").createNewFile());
            f.cleanupFailures.set(1);
            f.coordinator.disconnectVault(id);
            await(() -> f.store.snapshot().optString("error").contains("Private cleanup pending"));
            assertTrue(journal.exists()); assertTrue(f.tombstone(id));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            f.coordinator.settingsChanged(); f.coordinator.settingsChanged();
            await(() -> !journal.exists() && !f.tombstone(id));
        }
    }

    @Test public void expiredEnrollmentSessionRecoversAnAlreadyApprovedCredential() throws Exception {
        try (Fixture f = new Fixture(0, 60_000); java.net.ServerSocket server = new java.net.ServerSocket(0)) {
            java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
            Thread responder = new Thread(() -> {
                try {
                    for (int i = 0; i < 2; i++) try (java.net.Socket socket = server.accept()) {
                        java.io.BufferedReader input = new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream(), java.nio.charset.StandardCharsets.UTF_8));
                        assertEquals(i == 0 ? "POST /v1/auth/enrollments HTTP/1.1" : "GET /v1/vaults HTTP/1.1", input.readLine());
                        String line; boolean authorized = false; int length = 0;
                        while ((line = input.readLine()) != null && !line.isEmpty()) {
                            if (line.equalsIgnoreCase("Authorization: Bearer saved-approved-token")) authorized = true;
                            if (line.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(line.substring(15).trim());
                        }
                        assertTrue(authorized);
                        for (int j = 0; j < length; j++) assertTrue(input.read() >= 0);
                        String body = i == 0 ? "{}" : "{\"protocolVersion\":1,\"vaults\":[]}";
                        String response = "HTTP/1.1 " + (i == 0 ? "401 Unauthorized" : "200 OK") + "\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: " + body.length() + "\r\n\r\n" + body;
                        socket.getOutputStream().write(response.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                    }
                } catch (Throwable e) { failure.set(e); }
            });
            responder.setDaemon(true); responder.start();
            String id = f.store.snapshot().getJSONArray("servers").getJSONObject(0).getString("id");
            f.store.mutate(config -> {
                try {
                    config.put("allowHttp", true);
                    config.getJSONArray("servers").getJSONObject(0).put("baseUrl", "http://127.0.0.1:" + server.getLocalPort())
                            .put("enrollmentStatus", "pending").put("sessionToken", "saved-approved-token")
                            .put("deviceId", UUID.randomUUID().toString()).put("deviceName", "Test Android").put("fingerprint", "test-fingerprint");
                } catch (Exception e) { throw new AssertionError(e); }
            });
            f.coordinator.resumeEnrollment(id);
            await(() -> "approved".equals(f.store.snapshot().optJSONArray("servers").optJSONObject(0).optString("enrollmentStatus")) || failure.get() != null);
            if (failure.get() != null) throw new AssertionError(failure.get());
            assertEquals("saved-approved-token", f.store.snapshot().getJSONArray("servers").getJSONObject(0).getString("token"));
            responder.join(1000);
        }
    }

    @Test public void deferredBootAndStaleServiceDestroyCannotStopCurrentOwner() throws Exception {
        try (Fixture f = new Fixture(1, 60_000)) {
            Object oldOwner = new Object(), currentOwner = new Object();
            f.coordinator.serviceStarted(oldOwner);
            f.coordinator.serviceStarted(currentOwner);
            f.coordinator.serviceStopped(oldOwner, "stale destroy");
            java.util.concurrent.atomic.AtomicBoolean prompted = new java.util.concurrent.atomic.AtomicBoolean();
            f.coordinator.resumeAfterReboot(() -> prompted.set(true));
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            assertFalse(prompted.get());
            assertNotNull(f.runs.get(f.ids.get(0)));
            assertFalse(f.runs.get(f.ids.get(0)).cancelled);
            assertTrue(f.vault(0).optBoolean("running"));
        }
    }

    @Test public void timeoutWaitsForDrainThenGivesFifthVaultFirstTurnAndRetainsJournal() throws Exception {
        try (Fixture f = new Fixture(5, 250)) {
            for (String id : f.ids) f.coordinator.syncNow(id, false);
            await(() -> f.runs.size() == 4 && f.runs.values().stream().allMatch(run -> run.cancelled));
            assertNull(f.runs.get(f.ids.get(4)));
            assertTrue(f.vault(0).optBoolean("running"));
            assertTrue(f.vault(0).optInt("runTimeouts") > 0);
            assertTrue(f.vault(0).optString("status").contains("Timeout"));
            File journal = f.store.journalDirectory(f.ids.get(0));
            File checkpoint = new File(journal, "resume-checkpoint"); assertTrue(checkpoint.createNewFile());
            f.runs.get(f.ids.get(0)).drain();
            await(() -> f.runs.containsKey(f.ids.get(4)));
            assertFalse(f.runs.get(f.ids.get(4)).cancelled);
            assertTrue(checkpoint.exists());
            assertFalse(f.vault(0).optBoolean("initialSyncComplete"));
        }
    }

    @Test public void slowRetriesReserveCapacityForFreshVaults() throws Exception {
        try (Fixture f = new Fixture(6, 1000)) {
            for (int i = 0; i < 5; i++) f.coordinator.syncNow(f.ids.get(i), false);
            await(() -> f.runs.size() == 4 && f.runs.values().stream().allMatch(run -> run.cancelled));
            List<FakeRun> original = new ArrayList<>(f.runs.values());
            for (FakeRun run : original) run.drain();
            await(() -> f.runs.containsKey(f.ids.get(4)) && f.runs.values().stream().filter(run -> !run.cancelled).count() == 4);
            f.runs.get(f.ids.get(4)).listener.onFinished(new JSONObject().put("revisionId", UUID.randomUUID().toString())
                    .put("sequence", 1).put("pendingUploads", 0).put("pendingDownloads", 0));
            await(() -> !f.vault(4).optBoolean("running"));
            f.coordinator.syncNow(f.ids.get(5), false);
            await(() -> f.runs.containsKey(f.ids.get(5)));
            assertFalse(f.runs.get(f.ids.get(5)).cancelled);
            assertTrue(f.vault(5).optBoolean("running"));
        }
    }

    @Test public void disconnectPersistsCleanupUntilDrainAndRecreationFinishesPendingCleanup() throws Exception {
        try (Fixture f = new Fixture(1, 60_000)) {
            String id = f.ids.get(0);
            f.coordinator.syncNow(id, false);
            await(() -> f.runs.containsKey(id));
            File journal = f.store.journalDirectory(id);
            File stage = new File(journal, "stage"); assertTrue(stage.createNewFile());
            f.coordinator.disconnectVault(id);
            await(() -> f.tombstone(id));
            assertNull(f.vault(0)); assertTrue(stage.exists());
            f.runs.get(id).drain();
            await(() -> !f.tombstone(id) && !journal.exists());

            // Seed exactly the durable state left by process death before cleanup ran.
            String orphan = UUID.randomUUID().toString();
            File orphanDirectory = f.store.journalDirectory(orphan);
            assertTrue(new File(orphanDirectory, "large-stage").createNewFile());
            f.store.mutate(config -> { try { config.put("cleanupJournals", new JSONArray().put(orphan)); }
                catch (Exception e) { throw new AssertionError(e); } });
            new SyncCoordinator(f.context, f.store, null, new SyncCoordinator.ExecutionEnvironment());
            await(() -> !orphanDirectory.exists() && !f.tombstone(orphan));
        }
    }
}
