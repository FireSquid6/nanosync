package org.nanosync.mobile;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import org.json.JSONObject;

/** Policy boundary tests; run on an Android instrumentation target. */
@RunWith(AndroidJUnit4.class)
public final class SyncCoordinatorTest {
    @Test public void serverUrlsRejectCredentialsAndInsecureTransportByDefault() {
        for (String url : new String[]{"http://example.com", "https://user:secret@example.com", "https://example.com/?secret=x", "https://example.com/#fragment", "file:///tmp/server", "https://example.com/prefix", "https://example.com/a/../prefix", "https://example.com/%2f"}) {
            try { SyncCoordinator.canonicalServerUrl(url, false); fail("Accepted unsafe URL"); }
            catch (IllegalArgumentException expected) { }
        }
        assertEquals("https://example.com", SyncCoordinator.canonicalServerUrl("https://EXAMPLE.com:443/", false));
        assertEquals("http://example.com", SyncCoordinator.canonicalServerUrl("http://example.com/", true));
    }

    @Test public void verificationCodeMatchesProtocolAndUsesSavedRequestIdentity() {
        byte[] bytes = new byte[32];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) i;
        String fingerprint = android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
        assertEquals("123E4567-E89B-42D3-A456-426614174000-0001020304050607",
                SyncCoordinator.enrollmentVerificationCode("123e4567-e89b-42d3-a456-426614174000", fingerprint));
        try { SyncCoordinator.enrollmentVerificationCode("123e4567-e89b-42d3-a456-426614174000", fingerprint + "="); fail("Accepted noncanonical fingerprint"); }
        catch (IllegalArgumentException expected) { }
    }

    @Test public void disconnectRemovesOnlyConnectionAndPrivateJournal() throws Exception {
        android.content.Context context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().getTargetContext();
        AppStore store = AppStore.get(context);
        JSONObject original = store.snapshot();
        String serverId = java.util.UUID.randomUUID().toString();
        String connectionId = java.util.UUID.randomUUID().toString();
        java.io.File root = new java.io.File(context.getCacheDir(), "coordinator-test-" + connectionId);
        assertTrue(root.mkdir());
        java.io.File sharedFile = new java.io.File(root, "keep.txt");
        assertTrue(sharedFile.createNewFile());
        java.io.File journal = store.journalDirectory(connectionId);
        assertTrue(new java.io.File(journal, "checkpoint").createNewFile());
        try {
            JSONObject vault = new JSONObject().put("id", connectionId).put("vaultId", java.util.UUID.randomUUID().toString())
                    .put("rootPath", root.getPath()).put("masterKeyHex", "a".repeat(64));
            JSONObject server = new JSONObject().put("id", serverId).put("vaults", new org.json.JSONArray().put(vault));
            store.update(new JSONObject().put("servers", new org.json.JSONArray().put(server)));
            SyncCoordinator coordinator = new SyncCoordinator(context, store, null);
            coordinator.disconnectVault(connectionId);
            long until = System.currentTimeMillis() + 5000;
            while (System.currentTimeMillis() < until && (journal.exists()
                    || store.snapshot().getJSONArray("servers").getJSONObject(0).getJSONArray("vaults").length() != 0)) Thread.sleep(25);
            assertTrue(sharedFile.exists());
            assertFalse(journal.exists());
            assertEquals(0, store.snapshot().getJSONArray("servers").getJSONObject(0).getJSONArray("vaults").length());
        } finally {
            store.update(original);
            sharedFile.delete(); root.delete(); store.removeJournal(connectionId);
        }
    }

    @Test public void testMobilePolicyDoesNotTurnWifiPreferenceIntoOverride() throws Exception {
        JSONObject config = new JSONObject().put("defaultMobile", true);
        JSONObject vault = new JSONObject().put("mobilePolicy", "wifi");
        assertFalse(SyncCoordinator.effectiveMobileAllowed(config, vault, false));
        assertTrue(SyncCoordinator.effectiveMobileAllowed(config, vault, true));
        vault.put("mobilePolicy", "default");
        assertTrue(SyncCoordinator.effectiveMobileAllowed(config, vault, false));
        config.put("defaultMobile", false);
        assertFalse(SyncCoordinator.effectiveMobileAllowed(config, vault, false));
    }
}
