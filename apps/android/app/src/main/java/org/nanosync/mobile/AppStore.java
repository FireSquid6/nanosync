package org.nanosync.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Private, whole-config authenticated encryption. Never stores metadata in shared vault folders. */
public final class AppStore {
    private static AppStore singleton;
    private final State state;

    /** One backing state and write lock per process, including legacy constructor callers. */
    public static synchronized AppStore get(Context context) {
        if (singleton == null) singleton = new AppStore(new State(context.getApplicationContext()));
        return singleton;
    }

    public AppStore(Context context) {
        state = get(context).state;
    }

    private AppStore(State state) {
        this.state = state;
    }

    public JSONObject snapshot() { return state.snapshot(); }
    /** Full replacement; use mutate for read-modify-write to avoid stale snapshots. */
    public void update(JSONObject fullConfig) { state.update(fullConfig); }

    /** Atomic read-modify-write. Run on a worker; callback must not perform network work. */
    public void mutate(Consumer<JSONObject> edit) {
        synchronized (state) {
            JSONObject next = state.snapshot();
            edit.accept(next);
            state.update(next);
        }
    }

    public File journalDirectory(String connectionId) { return state.journalDirectory(connectionId); }
    public void removeJournal(String connectionId) { state.removeJournal(connectionId); }

    private static final class State {
        private static final String KEY_ALIAS = "nanosync.config.v1";
        private static final byte[] AAD = "nanosync.config.v1".getBytes(StandardCharsets.UTF_8);
        private final AtomicFile file;
        private final File journals;
        private JSONObject config;

        State(Context context) {
            File directory = new File(context.getNoBackupFilesDir(), "nanosync");
            if (!directory.isDirectory() && !directory.mkdirs()) {
                throw new IllegalStateException("Cannot open private Nanosync storage.");
            }
            file = new AtomicFile(new File(directory, "config.enc"));
            journals = new File(directory, "journals");
            try {
                // AtomicFile.openRead also recovers an interrupted write's backup.
                if (file.getBaseFile().exists() || new File(file.getBaseFile() + ".bak").exists()) {
                    byte[] bytes = file.readFully();
                    if (bytes.length < 1 + 12 + 16 || bytes[0] != 1) throw new IOException("Invalid encrypted config");
                    byte[] iv = new byte[12];
                    System.arraycopy(bytes, 1, iv, 0, iv.length);
                    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                    cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
                    cipher.updateAAD(AAD);
                    config = normalize(new JSONObject(new String(
                            cipher.doFinal(bytes, 13, bytes.length - 13), StandardCharsets.UTF_8)));
                } else {
                    config = normalize(new JSONObject());
                }
            } catch (Exception e) {
                // Fail closed: do not silently replace config after key loss/corruption.
                throw new IllegalStateException("Cannot decrypt Nanosync settings. Restore access to this device's keystore; do not clear app data unless you have recovery keys.", e);
            }
        }

        public synchronized JSONObject snapshot() {
            return copy(config);
        }

        /** Replaces a complete configuration, committing to disk before publishing it in memory. */
        public synchronized void update(JSONObject fullConfig) {
            JSONObject next = normalize(copy(fullConfig));
            FileOutputStream stream = null;
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key());
                cipher.updateAAD(AAD);
                byte[] encrypted = cipher.doFinal(next.toString().getBytes(StandardCharsets.UTF_8));
                byte[] iv = cipher.getIV();
                if (iv.length != 12) throw new IOException("Unexpected encryption IV");
                byte[] bytes = ByteBuffer.allocate(1 + iv.length + encrypted.length)
                        .put((byte) 1).put(iv).put(encrypted).array();
                stream = file.startWrite();
                stream.write(bytes);
                file.finishWrite(stream);
                stream = null;
                config = next;
            } catch (Exception e) {
                if (stream != null) file.failWrite(stream);
                throw new IllegalStateException("Could not save settings. Check free device storage and try again.", e);
            }
        }

        /** Worker-thread API: journals can contain sensitive sync metadata and stay private. */
        public synchronized File journalDirectory(String connectionId) {
            File directory = journalPath(connectionId);
            if (!directory.isDirectory() && !directory.mkdirs()) {
                throw new IllegalStateException("Cannot create private sync journal.");
            }
            return directory;
        }

        /** Worker-thread API. Never follows links outside the private journal root. */
        public synchronized void removeJournal(String connectionId) {
            File directory = journalPath(connectionId);
            try {
                deleteTree(directory, directory.getCanonicalFile());
            } catch (IOException e) {
                throw new IllegalStateException("Could not remove private sync journal.", e);
            }
        }

        private File journalPath(String id) {
            requireUuid(id);
            File result = new File(journals, id);
            try {
                if (!result.getCanonicalFile().equals(new File(journals.getCanonicalFile(), id))) {
                    throw new IllegalArgumentException("Invalid journal path");
                }
            } catch (IOException e) {
                throw new IllegalStateException("Cannot resolve private journal path.", e);
            }
            return result;
        }

        private static void deleteTree(File file, File root) throws IOException {
            if (!file.exists()) return;
            File canonical = file.getCanonicalFile();
            if (!canonical.equals(root) && !canonical.toPath().startsWith(root.toPath())) {
                // Remove a link, not its target.
                if (!file.delete()) throw new IOException("Cannot delete journal link");
                return;
            }
            // A symlink inside the tree must not be traversed (including cycles).
            if (!java.nio.file.Files.isSymbolicLink(file.toPath()) && file.isDirectory()) {
                File[] children = file.listFiles();
                if (children == null) throw new IOException("Cannot read journal directory");
                for (File child : children) deleteTree(child, root);
            }
            if (!file.delete()) throw new IOException("Cannot delete journal entry");
        }

        private static SecretKey key() throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256).build());
            return generator.generateKey();
        }

        private static JSONObject copy(JSONObject value) {
            if (value == null) throw new IllegalArgumentException("Configuration is required");
            try { return new JSONObject(value.toString()); }
            catch (JSONException e) { throw new IllegalArgumentException("Invalid configuration", e); }
        }

        private static void requireUuid(String id) {
            if (id == null) throw new IllegalArgumentException("Missing UUID");
            try {
                if (!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException("Noncanonical UUID");
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException("Invalid UUID", e);
            }
        }

        private static void defaults(JSONObject object, String key, Object value) throws JSONException {
            if (!object.has(key)) object.put(key, value);
        }

        private static JSONObject normalize(JSONObject value) {
            try {
                defaults(value, "allowHttp", false);
                defaults(value, "defaultMobile", false);
                defaults(value, "mobilePrompted", false);
                defaults(value, "servers", new JSONArray());
                JSONArray servers = value.getJSONArray("servers");
                Set<String> serverIds = new HashSet<>();
                Set<String> connectionIds = new HashSet<>();
                for (int i = 0; i < servers.length(); i++) {
                    JSONObject server = servers.getJSONObject(i);
                    String id = server.getString("id");
                    requireUuid(id);
                    if (!serverIds.add(id)) throw new IllegalArgumentException("Duplicate server UUID");
                    defaults(server, "alias", "");
                    defaults(server, "baseUrl", "");
                    defaults(server, "deviceId", "");
                    defaults(server, "fingerprint", "");
                    defaults(server, "enrollmentStatus", "pending");
                    defaults(server, "vaults", new JSONArray());
                    JSONArray vaults = server.getJSONArray("vaults");
                    for (int j = 0; j < vaults.length(); j++) {
                        JSONObject vault = vaults.getJSONObject(j);
                        String connectionId = vault.getString("id");
                        requireUuid(connectionId);
                        if (!connectionIds.add(connectionId)) throw new IllegalArgumentException("Duplicate connection UUID");
                        defaults(vault, "vaultId", "");
                        defaults(vault, "name", "");
                        defaults(vault, "rootPath", "");
                        defaults(vault, "masterKeyHex", "");
                        defaults(vault, "background", false);
                        defaults(vault, "paused", false);
                        defaults(vault, "mobilePolicy", "default");
                        String policy = vault.getString("mobilePolicy");
                        if (!policy.equals("default") && !policy.equals("allow") && !policy.equals("wifi")) {
                            throw new IllegalArgumentException("Invalid mobile data policy");
                        }
                        defaults(vault, "status", "Not synced");
                        defaults(vault, "lastSuccess", JSONObject.NULL);
                        defaults(vault, "error", "");
                        defaults(vault, "conflicts", new JSONArray());
                        defaults(vault, "pendingUploads", 0);
                        defaults(vault, "pendingDownloads", 0);
                        defaults(vault, "progress", "");
                        defaults(vault, "initialSyncComplete", false);
                    }
                }
                return value;
            } catch (JSONException e) {
                throw new IllegalArgumentException("Invalid configuration schema", e);
            }
        }
    }
}
