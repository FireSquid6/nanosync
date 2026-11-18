package org.nanosync.mobile;

import android.content.Context;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Base64;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
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

/** Native command boundary, real server approval, and real shared files; no fake backend. */
@RunWith(AndroidJUnit4.class)
public final class CoordinatorIntegrationTest {
    @Test public void enrollConnectPauseManualSyncAndDisconnectPreserveFiles() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String encoded = args.getString("fixture");
        org.junit.Assume.assumeTrue("Requires the disposable real-server fixture", encoded != null);
        JSONObject fixture = new JSONObject(new String(Base64.decode(encoded, Base64.DEFAULT), StandardCharsets.UTF_8));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        AppStore store = AppStore.get(context);
        JSONObject original = store.snapshot();
        String alias = fixture.getString("deviceName");
        SyncCoordinator coordinator = new SyncCoordinator(context, store, () -> { });
        String serverId = null;
        android.app.Activity visibleActivity = null;
        try {
            editStore(store, config -> {
                config.put("allowHttp", true);
                config.put("defaultMobile", false);
                config.put("mobilePrompted", true);
                config.remove("error");
            });
            coordinator.addServer(alias, fixture.getJSONObject("server").getString("baseUrl"),
                    fixture.getString("enrollmentPassword"), alias);
            JSONObject server = awaitServer(store, alias, true);
            serverId = server.getString("id");
            CountDownLatch listed = new CountDownLatch(1);
            AtomicReference<JSONArray> available = new AtomicReference<>();
            coordinator.listVaults(serverId, value -> { available.set(value); listed.countDown(); });
            assertTrue("Vault listing timed out", listed.await(30, TimeUnit.SECONDS));
            String vaultId = fixture.getJSONObject("vault").getString("vaultId");
            boolean found = false;
            for (int i = 0; i < available.get().length(); i++) {
                if (vaultId.equals(available.get().getJSONObject(i).getString("vaultId"))) found = true;
            }
            assertTrue("Approved Android device must list the existing vault: "
                    + findServer(store.snapshot(), alias).optString("error"), found);
            File root = new File(fixture.getString("coordinatorRoot")).getCanonicalFile();
            assertTrue(root.isDirectory());
            coordinator.connectVault(serverId, vaultId, "Integration vault", root.getPath(),
                    fixture.getJSONObject("vault").getString("recoveryKey"));
            JSONObject vault = awaitVault(store, alias, null);
            assertFalse(vault.optBoolean("background"));
            assertEquals("from second client\n", new String(Files.readAllBytes(new File(root, "remote.txt").toPath()), StandardCharsets.UTF_8));
            String id = vault.getString("id");
            File journal = store.journalDirectory(id);
            String previousSuccess = vault.getString("lastSuccess");
            editStore(store, config -> {
                JSONObject target = findServer(config, alias).getJSONArray("vaults").getJSONObject(0);
                target.put("paused", true);
            });
            coordinator.settingsChanged();
            Files.write(new File(root, "coordinator.txt").toPath(), "from native coordinator\n".getBytes(StandardCharsets.UTF_8));
            coordinator.syncNow(id, false);
            JSONObject manual = awaitVault(store, alias, previousSuccess);
            assertTrue("Manual sync must preserve pause", manual.optBoolean("paused"));
            assertFalse("Manual sync must not enable background work", manual.optBoolean("background"));
            // Wi-Fi-only is the real default, not an unconditional ban on syncing.
            // A one-time cellular exception must not change either stored policy.
            shell("svc data enable");
            shell("svc wifi disable");
            awaitTransport(context, android.net.NetworkCapabilities.TRANSPORT_CELLULAR);
            Files.write(new File(root, "mobile.txt").toPath(), "one-time mobile exception\n".getBytes(StandardCharsets.UTF_8));
            coordinator.syncNow(id, false);
            long blockedDeadline = SystemClock.uptimeMillis() + 10_000;
            while (SystemClock.uptimeMillis() < blockedDeadline && !findServer(store.snapshot(), alias)
                    .getJSONArray("vaults").getJSONObject(0).optString("status").equals("Waiting for permitted network")) SystemClock.sleep(50);
            JSONObject blocked = findServer(store.snapshot(), alias).getJSONArray("vaults").getJSONObject(0);
            assertEquals("Waiting for permitted network", blocked.getString("status"));
            assertEquals("Blocked cellular work cannot become a successful sync", manual.getString("lastSuccess"), blocked.getString("lastSuccess"));
            coordinator.syncNow(id, true);
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            manual = awaitVault(store, alias, manual.getString("lastSuccess"));
            assertTrue(manual.optBoolean("paused"));
            assertEquals("default", manual.getString("mobilePolicy"));
            assertFalse("One-time exception cannot change the global default", store.snapshot().optBoolean("defaultMobile"));
            shell("svc wifi enable");
            awaitTransport(context, android.net.NetworkCapabilities.TRANSPORT_WIFI);
            // Enabling persistent work is a visible user action. A background test
            // runner is not itself an Android foreground-service start exemption.
            visibleActivity = InstrumentationRegistry.getInstrumentation().startActivitySync(
                    new android.content.Intent(context, MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            editStore(store, config -> {
                JSONObject target = findServer(config, alias).getJSONArray("vaults").getJSONObject(0);
                target.put("paused", false).put("background", true);
            });
            coordinator.settingsChanged();
            // Android 12 may defer displaying an FGS notification for ten seconds.
            long notificationDeadline = SystemClock.uptimeMillis() + 20_000;
            while (!hasOngoingNotification(context) && SystemClock.uptimeMillis() < notificationDeadline) SystemClock.sleep(50);
            assertTrue("User-enabled foreground sync must start visibly", hasOngoingNotification(context));
            android.app.Activity startedActivity = visibleActivity;
            InstrumentationRegistry.getInstrumentation().runOnMainSync(startedActivity::finish);
            visibleActivity = null;
            // Scheduling now survives without an Activity or JavaScript interval timer.
            shell("input keyevent 223");
            long screenDeadline = SystemClock.uptimeMillis() + 5_000;
            while (context.getSystemService(android.os.PowerManager.class).isInteractive()
                    && SystemClock.uptimeMillis() < screenDeadline) SystemClock.sleep(50);
            assertFalse("Screen-off precondition", context.getSystemService(android.os.PowerManager.class).isInteractive());
            Files.write(new File(root, "background.txt").toPath(), "screen-off background sync\n".getBytes(StandardCharsets.UTF_8));
            JSONObject firstBackground = awaitVault(store, alias, manual.getString("lastSuccess"));
            awaitVault(store, alias, firstBackground.getString("lastSuccess"));
            boolean ongoing = false;
            for (android.service.notification.StatusBarNotification notification :
                    context.getSystemService(android.app.NotificationManager.class).getActiveNotifications()) {
                if ((notification.getNotification().flags & android.app.Notification.FLAG_ONGOING_EVENT) != 0) ongoing = true;
            }
            assertTrue("Active background sync must have an ongoing notification", ongoing);
            // Exercise the actual OS JobService fallback without starting a forbidden
            // foreground service from a boot receiver. The test forces its schedule,
            // not its implementation, to avoid waiting for the 15-minute interval.
            context.stopService(new android.content.Intent(context, SyncService.class));
            ResumeReceiver.schedule(context);
            long stoppedDeadline = SystemClock.uptimeMillis() + 10_000;
            while (hasOngoingNotification(context) && SystemClock.uptimeMillis() < stoppedDeadline) SystemClock.sleep(50);
            assertFalse("Foreground service must stop before fallback work", hasOngoingNotification(context));
            JSONObject beforeJob = findServer(store.snapshot(), alias).getJSONArray("vaults").getJSONObject(0);
            Files.write(new File(root, "job.txt").toPath(), "bounded scheduled job\n".getBytes(StandardCharsets.UTF_8));
            shell("cmd jobscheduler run -f " + context.getPackageName() + " " + ResumeReceiver.PERIODIC_JOB_ID);
            awaitVault(store, alias, beforeJob.getString("lastSuccess"));
            assertFalse("Scheduled work must not relaunch a foreground service", hasOngoingNotification(context));
            shell("input keyevent 224");
            coordinator.disconnectVault(id);
            long deadline = SystemClock.uptimeMillis() + 30_000;
            while (SystemClock.uptimeMillis() < deadline) {
                JSONObject current = findServer(store.snapshot(), alias);
                if (current != null && current.getJSONArray("vaults").length() == 0 && !journal.exists()) break;
                SystemClock.sleep(50);
            }
            assertEquals(0, findServer(store.snapshot(), alias).getJSONArray("vaults").length());
            assertFalse("Disconnect must reclaim private journal", journal.exists());
            assertTrue("Disconnect must preserve shared files", new File(root, "coordinator.txt").isFile());
        } finally {
            if (visibleActivity != null) {
                android.app.Activity remainingActivity = visibleActivity;
                InstrumentationRegistry.getInstrumentation().runOnMainSync(remainingActivity::finish);
            }
            shell("svc wifi enable");
            shell("input keyevent 224");
            if (serverId != null) {
                coordinator.removeServer(serverId);
                long deadline = SystemClock.uptimeMillis() + 30_000;
                while (SystemClock.uptimeMillis() < deadline && findServer(store.snapshot(), alias) != null) SystemClock.sleep(50);
            }
            store.update(original);
            coordinator.settingsChanged();
        }
    }

    private static void awaitTransport(Context context, int transport) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 30_000;
        android.net.ConnectivityManager manager = context.getSystemService(android.net.ConnectivityManager.class);
        do {
            android.net.NetworkCapabilities caps = manager.getNetworkCapabilities(manager.getActiveNetwork());
            if (caps != null && caps.hasTransport(transport)) return;
            SystemClock.sleep(50);
        } while (SystemClock.uptimeMillis() < deadline);
        fail("Disposable test device did not acquire transport " + transport);
    }

    private static boolean hasOngoingNotification(Context context) {
        for (android.service.notification.StatusBarNotification notification :
                context.getSystemService(android.app.NotificationManager.class).getActiveNotifications()) {
            if ((notification.getNotification().flags & android.app.Notification.FLAG_ONGOING_EVENT) != 0) return true;
        }
        return false;
    }

    private static void shell(String command) throws Exception {
        try (android.os.ParcelFileDescriptor descriptor = InstrumentationRegistry.getInstrumentation()
                    .getUiAutomation().executeShellCommand(command);
                java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            byte[] buffer = new byte[1024];
            while (output.read(buffer) >= 0) { }
        }
    }

    private interface Edit { void apply(JSONObject value) throws Exception; }
    private static void editStore(AppStore store, Edit edit) {
        store.mutate(config -> {
            try { edit.apply(config); }
            catch (Exception e) { throw new IllegalStateException(e); }
        });
    }

    private static JSONObject awaitServer(AppStore store, String alias, boolean approved) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 90_000;
        do {
            JSONObject server = findServer(store.snapshot(), alias);
            if (server != null && (!approved || "approved".equals(server.optString("enrollmentStatus")))) return server;
            SystemClock.sleep(50);
        } while (SystemClock.uptimeMillis() < deadline);
        fail("Native enrollment did not reach approval; check disposable fixture approval loop");
        return null;
    }
    private static JSONObject awaitVault(AppStore store, String alias, String previousSuccess) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 90_000;
        do {
            JSONObject snapshot = store.snapshot();
            JSONObject server = findServer(snapshot, alias);
            if (!snapshot.optString("error").isEmpty()) fail("Native connection failed: " + snapshot.optString("error"));
            if (server != null && server.getJSONArray("vaults").length() > 0) {
                JSONObject vault = server.getJSONArray("vaults").getJSONObject(0);
                if (vault.optBoolean("initialSyncComplete") && !vault.optBoolean("running")
                        && (previousSuccess == null || !previousSuccess.equals(vault.optString("lastSuccess")))) return vault;
                String status = vault.optString("status");
                if (!vault.optString("error").isEmpty() && (status.equals("Retry waiting") || status.equals("Blocked")
                        || status.equals("Incomplete") || status.equals("Waiting for permitted network"))) {
                    fail("Native sync failed: " + vault.optString("error"));
                }
            }
            SystemClock.sleep(50);
        } while (SystemClock.uptimeMillis() < deadline);
        fail("Native synchronization did not finish");
        return null;
    }
    private static JSONObject findServer(JSONObject config, String alias) throws Exception {
        JSONArray servers = config.getJSONArray("servers");
        for (int i = 0; i < servers.length(); i++) {
            JSONObject server = servers.getJSONObject(i);
            if (alias.equals(server.optString("alias"))) return server;
        }
        return null;
    }
}
