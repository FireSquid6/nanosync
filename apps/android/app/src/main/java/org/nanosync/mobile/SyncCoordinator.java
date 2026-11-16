package org.nanosync.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.IOException;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/** Process-wide ownership; all execution state and WebView lifecycle is confined to main. */
public final class SyncCoordinator implements UiActions {
    private static Shared shared;
    private final Shared state;
    // The Activity owns its coordinator; the process owns only a weak callback.
    private final Runnable callback;

    public SyncCoordinator(Context context, AppStore store, Runnable onChanged) {
        synchronized (SyncCoordinator.class) {
            if (shared == null) shared = new Shared(context.getApplicationContext(), AppStore.get(context));
            state = shared;
        }
        callback = onChanged;
        state.main.post(state::retryCleanup);
        if (onChanged != null) state.main.post(() -> state.observers.add(new WeakReference<>(onChanged)));
    }

    // Injectable platform/runtime seam for ownership tests without real storage/network transfers.
    SyncCoordinator(Context context, AppStore store, Runnable ignoredCallback, ExecutionEnvironment environment) {
        state = new Shared(context.getApplicationContext(), store, environment);
        callback = null;
    }
    interface RuntimeHandle { void start(); void cancel(); }
    static class ExecutionEnvironment {
        RuntimeHandle create(Context context, File journal, JSONObject server, JSONObject vault,
                boolean allowHttp, boolean override, EngineRuntime.Listener listener) {
            EngineRuntime runtime = new EngineRuntime(context, journal, server, vault, allowHttp, override, listener);
            return new RuntimeHandle() {
                public void start() { runtime.start(); }
                public void cancel() { runtime.cancel(); }
            };
        }
        void startBackgroundService(Context context) { context.startForegroundService(new Intent(context, SyncService.class)); }
        void removeJournal(AppStore store, String id) { store.removeJournal(id); }
        long budgetMillis(int previousYields) {
            // Transfer/apply checkpoints survive each yield. Increase the CPU/scan window on
            // retries too, so a large initial inventory is not perpetually cut at two minutes.
            return Math.min(24 * 60 * 60_000L, 120_000L << Math.min(previousYields, 10));
        }
        boolean networkAllowed(Context context, boolean mobile) {
            ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
            Network network = manager.getActiveNetwork();
            NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
            return capabilities != null && (mobile || NetworkPolicy.isWifi(capabilities));
        }
        File validateRoot(String path) throws IOException { return checkedRoot(path); }
    }

    static SyncCoordinator forService(Context context) {
        synchronized (SyncCoordinator.class) {
            if (shared == null) shared = new Shared(context.getApplicationContext(), AppStore.get(context));
            return new SyncCoordinator(context, shared.store, null);
        }
    }

    public static boolean effectiveMobileAllowed(JSONObject config, JSONObject vault, boolean override) {
        String policy = vault.optString("mobilePolicy", "default");
        return override || "allow".equals(policy) || ("default".equals(policy) && config.optBoolean("defaultMobile"));
    }

    /** Canonical server prefix; redirect responses are never followed. */
    public static String canonicalServerUrl(String value, boolean allowHttp) {
        try {
            URI uri = new URI(value.contains("://") ? value : "https://" + value).normalize();
            String scheme = uri.getScheme();
            if (!("https".equals(scheme) || allowHttp && "http".equals(scheme))
                    || uri.getHost() == null || uri.getUserInfo() != null || uri.getRawQuery() != null
                    || uri.getRawFragment() != null || uri.getPort() > 65535 || uri.getPort() == 0
                    || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath())))
                throw new IllegalArgumentException();
            int port = uri.getPort();
            if ("https".equals(scheme) && port == 443 || "http".equals(scheme) && port == 80) port = -1;
            uri = new URI(scheme, null, uri.getHost().toLowerCase(java.util.Locale.ROOT), port, uri.getPath(), null, null).normalize();
            String result = uri.toASCIIString();
            while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
            return result;
        } catch (Exception e) { throw new IllegalArgumentException("Use a valid HTTPS server URL without a path prefix, credentials, query or fragment. HTTP requires the HTTP setting."); }
    }

    @Override public void addServer(String alias, String url, String password, String deviceName) {
        state.io.execute(() -> {
            String id = UUID.randomUUID().toString();
            try {
                String canonical = canonicalServerUrl(url, state.store.snapshot().optBoolean("allowHttp"));
                if (deviceName == null || deviceName.trim().isEmpty() || deviceName.getBytes(StandardCharsets.UTF_8).length > 128
                        || deviceName.matches(".*[\\x00-\\x1f\\x7f].*")) throw new IOException("Enter a device name of 1–128 bytes.");
                if (password == null || password.isEmpty() || password.getBytes(StandardCharsets.UTF_8).length > 1024) throw new IOException("Enter a server password of 1–1024 bytes.");
                JSONObject login = state.request(canonical, "/v1/auth/password", null, new JSONObject().put("protocolVersion", 1).put("password", password));
                String token = login.getString("sessionToken");
                if (login.optInt("protocolVersion") != 1 || !token.matches("[A-Za-z0-9_-]{43}")) throw new IOException("Invalid password authentication response.");
                byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
                JSONObject server = new JSONObject().put("id", id).put("alias", alias).put("baseUrl", canonical)
                        .put("deviceId", UUID.randomUUID().toString()).put("deviceName", deviceName)
                        .put("fingerprint", Base64.encodeToString(random, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING))
                        .put("sessionToken", token).put("enrollmentStatus", "pending").put("vaults", new JSONArray());
                // Commit identity and session BEFORE the first potentially lost enrollment response.
                state.mutate(config -> {
                    JSONArray servers = config.getJSONArray("servers");
                    for (int i = 0; i < servers.length(); i++)
                        if (servers.getJSONObject(i).optString("baseUrl").equals(canonical)) throw new IOException("This server is already added. Resume its enrollment instead.");
                    servers.put(server);
                });
                resumeEnrollment(id);
            } catch (Exception e) { state.globalError(message(e)); }
        });
    }

    @Override public void resumeEnrollment(String serverId) {
        state.main.post(() -> {
            if (!state.enrolling.add(serverId)) return;
            state.io.execute(() -> {
                try {
                    JSONObject server = state.server(serverId);
                    if (server == null || "approved".equals(server.optString("enrollmentStatus"))) return;
                    String token = server.getString("sessionToken");
                    JSONObject request = new JSONObject().put("protocolVersion", 1).put("deviceId", server.getString("deviceId"))
                            .put("displayName", server.getString("deviceName")).put("platform", "android")
                            .put("clientVersion", "1").put("fingerprint", server.getString("fingerprint"));
                    JSONObject response = state.retryRequest(server, "/v1/auth/enrollments", token, request);
                    long until = System.currentTimeMillis() + 60_000;
                    while (true) {
                        if (response.optInt("protocolVersion") != 1 || !server.getString("deviceId").equals(response.optString("deviceId"))) throw new IOException("Unexpected enrollment identity in server response.");
                        String status = response.getString("status");
                        if (!status.matches("pending|approved|denied|expired")) throw new IOException("Unexpected enrollment response. Resume enrollment to retry.");
                        state.mutate(config -> {
                            JSONObject current = findServer(config, serverId);
                            if (current == null) return;
                            current.put("enrollmentStatus", status).put("error", "pending".equals(status)
                                    ? "Waiting for approval on the server. You can resume later."
                                    : "approved".equals(status) ? "" : "Enrollment " + status + ". Remove this server and enroll again.");
                            // Approval upgrades this exact password session; the API does not return a new token.
                            if ("approved".equals(status)) current.put("token", token);
                        });
                        if (!"pending".equals(status) || System.currentTimeMillis() >= until || state.server(serverId) == null) break;
                        Thread.sleep(1500);
                        response = state.retryRequest(server, "/v1/auth/enrollments/status", token, null);
                    }
                } catch (Exception e) {
                    if (e instanceof HttpFailure && ((HttpFailure) e).status == 401) {
                        state.recoverApproval(serverId);
                    } else state.serverError(serverId, "Enrollment paused. " + message(e) + " Resume to retry with the saved identity.");
                }
                finally { state.main.post(() -> state.enrolling.remove(serverId)); }
            });
        });
    }

    @Override public void listVaults(String serverId, Consumer<JSONArray> result) {
        state.io.execute(() -> {
            JSONArray available = new JSONArray();
            try {
                JSONObject server = state.server(serverId);
                if (server == null) throw new IOException("Server was removed.");
                JSONObject response = state.request(server.getString("baseUrl"), "/v1/vaults", server.getString("token"), null);
                JSONArray list = response.getJSONArray("vaults");
                JSONObject current = state.server(serverId);
                if (current != null) for (int i = 0; i < list.length(); i++) {
                    JSONObject vault = list.getJSONObject(i);
                    boolean connected = false;
                    JSONArray connections = current.getJSONArray("vaults");
                    for (int j = 0; j < connections.length(); j++)
                        if (connections.getJSONObject(j).optString("vaultId").equals(vault.optString("vaultId"))) connected = true;
                    if (!connected) available.put(vault);
                }
            } catch (Exception e) { state.serverError(serverId, message(e)); }
            JSONArray delivered = available;
            state.main.post(() -> result.accept(delivered));
        });
    }

    @Override public void connectVault(String serverId, String vaultId, String name, String rootPath, String recoveryKey) {
        state.main.post(() -> {
            String id = UUID.randomUUID().toString();
            try {
                File root = state.validateRoot(rootPath);
                for (Run active : state.runs.values()) {
                    if (active.root != null && overlap(root, active.root)) throw new IOException("This folder is still stopping. Wait before reconnecting.");
                    if (serverId.equals(active.serverId) && vaultId.equals(active.vaultId)) throw new IOException("This vault is still stopping. Wait before reconnecting.");
                }
                state.mutate(config -> {
                    JSONObject server = findServer(config, serverId);
                    if (server == null || !"approved".equals(server.optString("enrollmentStatus"))) throw new IOException("Approve this server before connecting a vault.");
                    JSONArray servers = config.getJSONArray("servers");
                    for (int i = 0; i < servers.length(); i++) {
                        JSONObject otherServer = servers.getJSONObject(i);
                        JSONArray vaults = otherServer.getJSONArray("vaults");
                        for (int j = 0; j < vaults.length(); j++) {
                            JSONObject other = vaults.getJSONObject(j);
                            if (otherServer.optString("id").equals(serverId) && other.optString("vaultId").equals(vaultId))
                                throw new IOException("This vault is already connected to this server.");
                            if (overlap(root, new File(other.getString("rootPath")))) throw new IOException("Choose a folder that does not overlap another connected folder.");
                        }
                    }
                    server.getJSONArray("vaults").put(new JSONObject().put("id", id).put("vaultId", vaultId).put("name", name)
                            .put("rootPath", root.getPath()).put("masterKeyHex", "").put("status", "Connecting"));
                });
                state.start(id, true, false, recoveryKey);
            } catch (Exception e) { state.serverError(serverId, message(e)); }
        });
    }

    @Override public void syncNow(String id, boolean override) { state.main.post(() -> state.start(id, true, override, null)); }
    @Override public void settingsChanged() {
        JSONObject settings = state.store.snapshot();
        state.main.post(() -> {
            state.refreshPolicies(settings);
            state.retryCleanup();
            state.reconcile();
            if (state.hasBackground()) {
                try {
                    state.environment.startBackgroundService(state.context);
                } catch (RuntimeException e) { state.backgroundUnavailable("Background sync could not start. Open Nanosync and allow background operation."); }
            }
        });
    }
    @Override public void disconnectVault(String id) { state.main.post(() -> state.disconnect(id)); }
    @Override public void removeServer(String id) {
        state.main.post(() -> {
            try {
                JSONObject server = state.server(id);
                if (server == null) return;
                JSONArray vaults = server.getJSONArray("vaults");
                for (int i = 0; i < vaults.length(); i++) state.disconnect(vaults.getJSONObject(i).getString("id"));
                state.mutate(config -> removeById(config.getJSONArray("servers"), id));
            } catch (Exception e) { state.globalError(message(e)); }
        });
    }

    void serviceStarted(Object owner) { state.main.post(() -> { state.serviceOwner = owner; state.serviceRunning = true; state.reconcile(); }); }
    void serviceStopped(Object owner, String reason) {
        state.main.post(() -> {
            if (state.serviceOwner != null && state.serviceOwner != owner) return;
            state.serviceOwner = null; state.serviceRunning = false; state.backgroundUnavailable(reason);
        });
    }
    void resumeAfterReboot(Runnable prompt) {
        state.main.post(() -> {
            if (state.serviceOwner != null || !state.hasBackground()) return;
            state.backgroundUnavailable("Device restarted. Open Nanosync to resume background sync; Android does not allow automatic dataSync startup at boot.");
            prompt.run();
        });
    }
    boolean hasBackground() { return state.hasBackground(); }
    void tick() { state.main.post(state::reconcile); }

    private interface Change { void apply(JSONObject config) throws Exception; }
    private static final class Run {
        RuntimeHandle runtime;
        Runnable deadline;
        boolean timedOut;
        boolean manual, override, cancelled, remove;
        String recovery;
        String policy;
        File root;
        String serverId, vaultId;
        long lastEvent;
        int previousYields;
        long generation;
    }
    private static final class StartRequest {
        final boolean manual, override;
        final String recovery;
        final long generation;
        StartRequest(boolean manual, boolean override, String recovery, long generation) {
            this.manual = manual; this.override = override; this.recovery = recovery; this.generation = generation;
        }
    }
    private static final class Shared {
        final Context context;
        final AppStore store;
        final ExecutionEnvironment environment;
        final Handler main = new Handler(Looper.getMainLooper());
        final ExecutorService io = Executors.newFixedThreadPool(4);
        final java.util.concurrent.ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
        final Map<String, Run> runs = new HashMap<>();
        final java.util.LinkedHashMap<String, StartRequest> queued = new java.util.LinkedHashMap<>();
        final Map<String, Long> next = new HashMap<>();
        final Map<String, Integer> failures = new HashMap<>();
        final Map<String, String> policyValues = new HashMap<>();
        final Map<String, Long> generations = new HashMap<>();
        final Set<String> cleanupWorkers = new HashSet<>();
        final Set<String> enrolling = new HashSet<>();
        final Set<HttpURLConnection> requests = java.util.concurrent.ConcurrentHashMap.newKeySet();
        final Set<String> notified = new HashSet<>();
        final ArrayList<WeakReference<Runnable>> observers = new ArrayList<>();
        boolean serviceRunning;
        Object serviceOwner;

        Shared(Context context, AppStore store) { this(context, store, new ExecutionEnvironment()); }
        Shared(Context context, AppStore store, ExecutionEnvironment environment) {
            this.context = context; this.store = store; this.environment = environment;
            // No runtime survives process death. Recovery journals do; never claim it is still running.
            mutate(config -> {
                JSONArray servers = config.getJSONArray("servers");
                for (int i = 0; i < servers.length(); i++) {
                    JSONArray vaults = servers.getJSONObject(i).getJSONArray("vaults");
                    for (int j = 0; j < vaults.length(); j++) {
                        JSONObject vault = vaults.getJSONObject(j);
                        vault.put("running", false).put("status", vault.optString("masterKeyHex").isEmpty()
                                ? "Connection incomplete. Disconnect and enter the recovery key again." : "Not running");
                    }
                }
            });
            retryCleanup();
        }
        void retryCleanup() {
            JSONArray cleanup = store.snapshot().optJSONArray("cleanupJournals");
            if (cleanup != null) for (int i = 0; i < cleanup.length(); i++) cleanupJournal(cleanup.optString(i));
        }
        void cleanupJournal(String id) {
            main.post(() -> {
                if (runs.containsKey(id) || findVault(store.snapshot(), id) != null || !cleanupWorkers.add(id)) return;
                io.execute(() -> {
                    try {
                        environment.removeJournal(store, id);
                        mutate(config -> {
                            JSONArray pending = config.optJSONArray("cleanupJournals");
                            if (pending != null) for (int i = pending.length() - 1; i >= 0; i--)
                                if (id.equals(pending.optString(i))) pending.remove(i);
                        });
                    } catch (RuntimeException e) { globalError("Private cleanup pending. Reopen Nanosync or retry settings to retry. " + message(e)); }
                    finally { main.post(() -> cleanupWorkers.remove(id)); }
                });
            });
        }
        String policyStamp(JSONObject config, JSONObject vault) {
            return config.optBoolean("allowHttp") + ":" + config.optBoolean("defaultMobile") + ":"
                    + vault.optString("mobilePolicy", "default") + ":" + vault.optBoolean("paused") + ":" + vault.optBoolean("background");
        }
        void refreshPolicies(JSONObject config) {
            JSONArray servers = config.optJSONArray("servers");
            for (int i = 0; i < servers.length(); i++) {
                JSONArray vaults = servers.optJSONObject(i).optJSONArray("vaults");
                for (int j = 0; j < vaults.length(); j++) {
                    JSONObject vault = vaults.optJSONObject(j); String id = vault.optString("id");
                    String stamp = policyStamp(config, vault), old = policyValues.put(id, stamp);
                    if (old != null && !old.equals(stamp)) generations.put(id, generations.getOrDefault(id, 0L) + 1);
                }
            }
        }
        boolean currentRequest(String id, StartRequest request) {
            JSONObject config = store.snapshot(), vault = findVault(config, id);
            return vault != null && request.generation == generations.getOrDefault(id, 0L)
                    && policyStamp(config, vault).equals(policyValues.get(id));
        }
        void discardQueued(String id, StartRequest request) {
            if (request.recovery != null) {
                globalError("Connection cancelled by a settings change. Reconnect and enter the recovery key again.");
                mutate(config -> removeConnection(config, id)); cleanupJournal(id);
            } else vaultState(id, vault -> vault.put("running", false).put("status", vault.optBoolean("paused") ? "Paused" : "Queued sync cancelled by settings change"));
        }
        void mutate(Change change) {
            store.mutate(config -> {
                try { change.apply(config); }
                catch (RuntimeException e) { throw e; }
                catch (Exception e) { throw new IllegalStateException(message(e), e); }
            });
            main.post(() -> {
                observers.removeIf(reference -> reference.get() == null);
                for (WeakReference<Runnable> reference : new ArrayList<>(observers)) {
                    Runnable observer = reference.get(); if (observer != null) observer.run();
                }
            });
        }
        JSONObject server(String id) { return findServer(store.snapshot(), id); }
        void recoverApproval(String id) {
            try {
                JSONObject saved = server(id);
                if (saved == null) return;
                String token = saved.getString("sessionToken");
                // Device credentials outlive password sessions. A lost approval can be recovered
                // even after enrollment/status starts rejecting the expired 24h session.
                JSONObject response = request(saved.getString("baseUrl"), "/v1/vaults", token, null);
                if (response.optInt("protocolVersion") != 1 || response.optJSONArray("vaults") == null) throw new IOException("Invalid device authorization response.");
                mutate(config -> { JSONObject current = findServer(config, id); if (current != null) current.put("enrollmentStatus", "approved").put("token", token).put("error", ""); });
            } catch (HttpFailure e) {
                if (e.status == 401 || e.status == 403) mutate(config -> { JSONObject current = findServer(config, id); if (current != null) current.put("enrollmentStatus", "expired").put("error", "Enrollment expired or access was revoked. Remove this server and enroll again."); });
                else serverError(id, "Could not verify approval. Resume to retry. " + message(e));
            } catch (Exception e) { serverError(id, "Could not verify approval. Resume to retry. " + message(e)); }
        }
        void vaultState(String id, Change change) {
            JSONObject vault = findVault(store.snapshot(), id);
            if (vault == null) return;
            String before = vault.toString();
            try { change.apply(vault); } catch (Exception e) { throw new IllegalStateException(message(e), e); }
            if (!before.equals(vault.toString())) mutate(config -> { JSONObject latest = findVault(config, id); if (latest != null) change.apply(latest); });
        }
        void globalError(String error) { mutate(config -> config.put("error", error)); }
        void serverError(String id, String error) { mutate(config -> { JSONObject server = findServer(config, id); if (server != null) server.put("error", error); }); }
        File validateRoot(String path) throws IOException { return environment.validateRoot(path); }
        boolean networkAllowed(boolean mobile) { return environment.networkAllowed(context, mobile); }
        boolean dispatching;
        void start(String id, boolean manual, boolean override, String recovery) {
            if (runs.containsKey(id) || queued.containsKey(id)) return;
            JSONObject config = store.snapshot(), vault = findVault(config, id), server = serverForVault(config, id);
            if (vault == null || server == null) return;
            if (recovery == null && vault.optString("masterKeyHex").isEmpty()) return;
            if (!manual && (vault.optBoolean("paused") || !vault.optBoolean("background") || !serviceRunning)) return;
            refreshPolicies(config);
            // Repeatedly slow passes may use three slots, never all four. The reserved
            // fresh-pass slot keeps healthy/new vaults responsive while large scans get
            // progressively longer windows without monopolizing every execution slot.
            long slowRuns = runs.values().stream().filter(run -> run.previousYields > 0).count();
            if (runs.size() >= 4 || vault.optInt("runTimeouts") > 0 && slowRuns >= 3 || !dispatching && !queued.isEmpty()) {
                queued.put(id, new StartRequest(manual, override, recovery, generations.getOrDefault(id, 0L)));
                vaultState(id, value -> value.put("running", false).put("status", "Queued"));
                if (!dispatching) main.post(this::drainQueue);
                return;
            }
            boolean mobile = effectiveMobileAllowed(config, vault, override);
            try {
                canonicalServerUrl(server.getString("baseUrl"), config.optBoolean("allowHttp"));
                validateRoot(vault.getString("rootPath"));
                if (!networkAllowed(mobile)) {
                    if (recovery != null) throw new IOException("Connect to a permitted network before recovering this vault.");
                    vaultState(id, value -> value.put("running", false).put("status", "Waiting for permitted network").put("error", "Connect to Wi-Fi or allow mobile data for this vault."));
                    return;
                }
                Run run = new Run(); run.manual = manual; run.override = override; run.recovery = recovery;
                run.previousYields = vault.optInt("runTimeouts");
                run.generation = generations.getOrDefault(id, 0L);
                run.policy = policy(config, vault, override);
                run.root = new File(vault.getString("rootPath"));
                run.serverId = server.getString("id"); run.vaultId = vault.getString("vaultId");
                runs.put(id, run);
                vault.put("effectiveMobileAllowed", mobile);
                if (recovery != null) vault.put("recoveryKey", recovery);
                run.runtime = environment.create(context, store.journalDirectory(id), server, vault, config.optBoolean("allowHttp"), override, new EngineRuntime.Listener() {
                    @Override public void onEvent(JSONObject event) { main.post(() -> event(id, run, event)); }
                    @Override public void onFinished(JSONObject result) { main.post(() -> finish(id, run, result, null)); }
                    @Override public void onError(String error) { main.post(() -> finish(id, run, null, error)); }
                });
                vaultState(id, value -> value.put("running", true).put("error", "").put("status", recovery == null ? "Syncing" : "Connecting"));
                run.deadline = () -> {
                    if (runs.get(id) != run || run.cancelled) return;
                    run.timedOut = true;
                    if (run.recovery != null) {
                        serverError(run.serverId, "Recovery timed out. Reconnect this vault and enter the recovery key again; the key was not saved.");
                        globalError("Recovery timed out. Reconnect this vault and enter the recovery key again.");
                    }
                    vaultState(id, value -> value.put("status", "Time budget reached; yielding")
                            .put("error", run.recovery == null ? "Sync is yielding to other folders. Saved transfers will resume on retry." : "Recovery timed out. Reconnect and enter the recovery key again.")
                            .put("runTimeouts", value.optInt("runTimeouts") + 1));
                    cancel(id, run);
                };
                main.postDelayed(run.deadline, environment.budgetMillis(vault.optInt("runTimeouts")));
                run.runtime.start();
            } catch (Exception e) {
                Run run = runs.get(id);
                if (run != null && run.runtime != null) cancel(id, run);
                else if (run != null) finish(id, run, null, message(e));
                else if (recovery != null) {
                    mutate(latest -> removeConnection(latest, id));
                    cleanupJournal(id);
                    serverError(server.optString("id"), message(e));
                }
                vaultState(id, value -> value.put("running", runs.containsKey(id))
                        .put("status", runs.containsKey(id) ? "Stopping" : "Blocked").put("error", message(e)));
                notifyAction(id, message(e));
            }
        }
        void event(String id, Run run, JSONObject event) {
            if (runs.get(id) != run || run.cancelled) return;
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - run.lastEvent < 1000) return;
            run.lastEvent = now;
            // Never blindly merge bridge events (they may contain transient secrets).
            vaultState(id, vault -> {
                for (String key : new String[]{"progress", "pendingUploads", "pendingDownloads"})
                    if (event.has(key)) vault.put(key, event.get(key));
            });
        }
        void finish(String id, Run run, JSONObject result, String error) {
            if (runs.get(id) != run) return;
            runs.remove(id);
            if (run.deadline != null) main.removeCallbacks(run.deadline);
            main.post(this::drainQueue);
            String recovery = run.recovery; run.recovery = null;
            if (run.remove) {
                mutate(config -> removeConnection(config, id));
                cleanupJournal(id); return;
            }
            if (run.cancelled && run.timedOut) {
                vaultState(id, vault -> vault.put("running", false).put("status", "Timeout; retry queued"));
                StartRequest retry = new StartRequest(run.manual, run.override, null, run.generation);
                if (currentRequest(id, retry)) queued.put(id, retry);
                return;
            }
            if (run.cancelled) {
                vaultState(id, vault -> vault.put("running", false).put("status", vault.optBoolean("paused") ? "Paused" : "Stopped"));
                next.put(id, System.currentTimeMillis() + 3000);
                return;
            }
            if (error == null && recovery != null && (result == null || !result.optString("masterKeyHex").matches("[0-9a-f]{64}"))) error = "Recovery did not return a valid vault key.";
            if (error != null) {
                String safe = recovery == null ? error : "Recovery failed. Check the recovery key and reconnect this vault.";
                if (recovery != null) {
                    mutate(config -> removeConnection(config, id));
                    cleanupJournal(id);
                    globalError(safe);
                } else {
                    vaultState(id, vault -> vault.put("running", false).put("status", "Retry waiting").put("error", safe));
                    int attempt = Math.min(8, failures.getOrDefault(id, 0) + 1); failures.put(id, attempt);
                    next.put(id, System.currentTimeMillis() + Math.min(300_000, 3000L << attempt));
                    String lower = safe.toLowerCase(java.util.Locale.ROOT);
                    if (lower.contains("permission") || lower.contains("storage") || lower.contains("revoked") || lower.contains("401") || lower.contains("403")) notifyAction(id, safe);
                }
                return;
            }
            failures.remove(id);
            next.put(id, System.currentTimeMillis() + 5000);
            if (recovery != null) {
                vaultState(id, vault -> vault.put("masterKeyHex", result.getString("masterKeyHex")).put("running", false).put("status", "Ready").put("error", ""));
                start(id, true, run.override, null);
            } else if (result != null && result.optString("revisionId").matches("[0-9a-f-]{36}") && result.optLong("sequence", -1) >= 0
                    && result.optInt("pendingUploads", -1) == 0 && result.optInt("pendingDownloads", -1) == 0) {
                vaultState(id, vault -> vault.put("running", false).put("status", "Up to date").put("error", "")
                        .put("runTimeouts", 0).put("lastSuccess", java.time.Instant.now().toString()).put("initialSyncComplete", true)
                        .put("conflicts", result.optJSONArray("conflicts") == null ? new JSONArray() : result.getJSONArray("conflicts"))
                        .put("conflictCount", result.optJSONArray("conflicts") == null ? 0 : result.optJSONArray("conflicts").length())
                        .put("exclusionsActive", result.optBoolean("exclusionsActive"))
                        .put("pendingUploads", result.optInt("pendingUploads")).put("pendingDownloads", result.optInt("pendingDownloads")));
                if (result.optJSONArray("conflicts") != null && result.optJSONArray("conflicts").length() > 0) notifyAction(id, "Conflicts need review. Open Nanosync for details.");
            } else {
                vaultState(id, vault -> vault.put("running", false).put("status", "Incomplete").put("error", "Sync did not return a completed revision. Retry sync."));
            }
        }
        void cancel(String id, Run run) {
            if (run.cancelled) return;
            run.cancelled = true;
            if (run.recovery != null) run.remove = true;
            run.recovery = null;
            vaultState(id, vault -> vault.put("status", run.timedOut ? "Timeout; stopping" : "Stopping"));
            // Listener terminal callback is the IO-drained fence. Do not delete journals here.
            run.runtime.cancel();
        }
        void drainQueue() {
            int waiting = queued.size();
            while (runs.size() < 4 && !queued.isEmpty() && waiting-- > 0) {
                String id = queued.keySet().iterator().next();
                StartRequest request = queued.remove(id);
                if (!currentRequest(id, request)) { discardQueued(id, request); continue; }
                dispatching = true;
                try { start(id, request.manual, request.override, request.recovery); }
                finally { dispatching = false; }
            }
        }
        void disconnect(String id) {
            queued.remove(id);
            Run run = runs.get(id);
            if (run != null) { run.remove = true; cancel(id, run); }
            mutate(config -> removeConnection(config, id));
            next.remove(id); failures.remove(id);
            if (run == null) cleanupJournal(id);
        }
        boolean hasBackground() {
            JSONObject config = store.snapshot();
            JSONArray servers = config.optJSONArray("servers");
            for (int i = 0; i < servers.length(); i++) {
                JSONArray vaults = servers.optJSONObject(i).optJSONArray("vaults");
                for (int j = 0; j < vaults.length(); j++) {
                    JSONObject vault = vaults.optJSONObject(j);
                    if (vault.optBoolean("background") && !vault.optBoolean("paused") && !vault.optString("masterKeyHex").isEmpty()) return true;
                }
            }
            return false;
        }
        void reconcile() {
            JSONObject config = store.snapshot();
            for (Map.Entry<String, StartRequest> entry : new ArrayList<>(queued.entrySet())) {
                if (!currentRequest(entry.getKey(), entry.getValue())) {
                    queued.remove(entry.getKey()); discardQueued(entry.getKey(), entry.getValue());
                }
            }
            if (!config.optBoolean("allowHttp")) for (HttpURLConnection connection : requests)
                if ("http".equals(connection.getURL().getProtocol())) connection.disconnect();
            for (Map.Entry<String, Run> entry : new ArrayList<>(runs.entrySet())) {
                String id = entry.getKey(); Run run = entry.getValue(); JSONObject vault = findVault(config, id);
                if (vault == null || run.generation != generations.getOrDefault(id, 0L) || !run.policy.equals(policy(config, vault, run.override))
                        || !networkAllowed(effectiveMobileAllowed(config, vault, run.override))
                        || !run.manual && (!serviceRunning || vault.optBoolean("paused") || !vault.optBoolean("background"))) {
                    run.timedOut = false; // Explicit policy/permission stops must not requeue a yielded manual pass.
                    cancel(id, run);
                }
            }
            JSONArray servers = config.optJSONArray("servers");
            for (int i = 0; i < servers.length(); i++) {
                JSONArray vaults = servers.optJSONObject(i).optJSONArray("vaults");
                for (int j = 0; j < vaults.length(); j++) {
                    JSONObject vault = vaults.optJSONObject(j); String id = vault.optString("id");
                    if (System.currentTimeMillis() >= next.getOrDefault(id, 0L)) start(id, false, false, null);
                }
            }
        }
        String policy(JSONObject config, JSONObject vault, boolean override) {
            // Pausing a manual one-pass run already paused is allowed; changing pause cancels it.
            return config.optBoolean("allowHttp") + ":" + effectiveMobileAllowed(config, vault, override) + ":" + vault.optBoolean("paused");
        }
        void backgroundUnavailable(String reason) {
            for (Map.Entry<String, Run> entry : new ArrayList<>(runs.entrySet())) if (!entry.getValue().manual) cancel(entry.getKey(), entry.getValue());
            mutate(config -> {
                JSONArray servers = config.getJSONArray("servers");
                for (int i = 0; i < servers.length(); i++) {
                    JSONArray vaults = servers.getJSONObject(i).getJSONArray("vaults");
                    for (int j = 0; j < vaults.length(); j++) {
                        JSONObject vault = vaults.getJSONObject(j);
                        if (vault.optBoolean("background")) vault.put("status", "Background not running").put("error", reason);
                    }
                }
            });
        }
        void notifyAction(String id, String text) {
            if (!notified.add(id + ":" + text)) return;
            try {
                NotificationManager manager = context.getSystemService(NotificationManager.class);
                manager.createNotificationChannel(new NotificationChannel("sync-actions", "Sync needs attention", NotificationManager.IMPORTANCE_DEFAULT));
                Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
                if (launch == null) return;
                manager.notify(id.hashCode(), new Notification.Builder(context, "sync-actions")
                        .setSmallIcon(android.R.drawable.stat_notify_error).setContentTitle("Nanosync needs attention").setContentText(text)
                        .setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true)
                        .setContentIntent(PendingIntent.getActivity(context, id.hashCode(), launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)).build());
            } catch (SecurityException ignored) { /* Permission opt-in belongs to visible UI; state remains actionable. */ }
        }
        JSONObject retryRequest(JSONObject server, String path, String token, JSONObject body) throws Exception {
            IOException last = null;
            for (int attempt = 0; attempt < 3; attempt++) {
                try { return request(server.getString("baseUrl"), path, token, body); }
                catch (HttpFailure e) { if (e.status < 500 && e.status != 429) throw e; last = e; }
                catch (IOException e) { last = e; }
                Thread.sleep(500L << attempt);
            }
            throw last;
        }
        JSONObject request(String base, String path, String token, JSONObject body) throws Exception {
            // Recheck global transport policy for EVERY request, not merely at enrollment start.
            String canonical = canonicalServerUrl(base, store.snapshot().optBoolean("allowHttp"));
            if (!networkAllowed(true)) throw new IOException("Network unavailable. Reconnect and retry.");
            HttpURLConnection connection = (HttpURLConnection) new URI(canonical + path).toURL().openConnection();
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15_000); connection.setReadTimeout(20_000);
            requests.add(connection);
            java.util.concurrent.atomic.AtomicBoolean expired = new java.util.concurrent.atomic.AtomicBoolean();
            java.util.concurrent.ScheduledFuture<?> timeout = deadlines.schedule(() -> {
                expired.set(true); connection.disconnect();
            }, 30, java.util.concurrent.TimeUnit.SECONDS);
            try {
                canonicalServerUrl(base, store.snapshot().optBoolean("allowHttp"));
                if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
                if (body != null) {
                    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    connection.setRequestMethod("POST"); connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json"); connection.setFixedLengthStreamingMode(bytes.length);
                    try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) throw new HttpFailure(status);
                try (InputStream input = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[4096]; int n;
                    while ((n = input.read(buffer)) != -1) {
                        if (bytes.size() + n > 1024 * 1024) throw new IOException("Server response too large.");
                        bytes.write(buffer, 0, n);
                    }
                    return new JSONObject(bytes.toString("UTF-8"));
                }
            } catch (Exception e) {
                if (expired.get()) throw new IOException("Request deadline reached. Check the network and retry.");
                throw e;
            } finally { timeout.cancel(false); requests.remove(connection); connection.disconnect(); }
        }
    }
    private static File checkedRoot(String path) throws IOException {
            File absolute = new File(path).getAbsoluteFile(), root = absolute.getCanonicalFile();
            File sharedRoot = Environment.getExternalStorageDirectory().getCanonicalFile();
            if (!absolute.equals(root) || !root.toPath().startsWith(sharedRoot.toPath()) || root.equals(sharedRoot)
                    || root.toPath().startsWith(new File(sharedRoot, "Android").toPath()))
                throw new IOException("Choose a dedicated folder in primary shared storage, outside Android/ and without links.");
            if (Build.VERSION.SDK_INT >= 30 && !Environment.isExternalStorageManager()) throw new IOException("Allow all-files storage access in Android settings, then retry.");
            if (!Environment.MEDIA_MOUNTED.equals(Environment.getExternalStorageState(root)) || !root.isDirectory() || !root.canRead() || !root.canWrite())
                throw new IOException("Folder unavailable. Restore storage access or choose an existing writable folder.");
            return root;
        }
    private static final class HttpFailure extends IOException {
        final int status;
        HttpFailure(int status) { super("Server returned HTTP " + status + ". Check server access and enrollment."); this.status = status; }
    }
    private static String message(Exception e) { return e.getMessage() == null ? "Operation failed. Check access and retry." : e.getMessage(); }
    private static boolean overlap(File first, File second) throws IOException {
        return first.getCanonicalFile().toPath().startsWith(second.getCanonicalFile().toPath()) || second.getCanonicalFile().toPath().startsWith(first.getCanonicalFile().toPath());
    }
    private static JSONObject findServer(JSONObject config, String id) {
        JSONArray servers = config.optJSONArray("servers");
        for (int i = 0; i < servers.length(); i++) if (id.equals(servers.optJSONObject(i).optString("id"))) return servers.optJSONObject(i);
        return null;
    }
    private static JSONObject findVault(JSONObject config, String id) {
        JSONObject server = serverForVault(config, id);
        if (server == null) return null;
        JSONArray vaults = server.optJSONArray("vaults");
        for (int i = 0; i < vaults.length(); i++) if (id.equals(vaults.optJSONObject(i).optString("id"))) return vaults.optJSONObject(i);
        return null;
    }
    private static JSONObject serverForVault(JSONObject config, String id) {
        JSONArray servers = config.optJSONArray("servers");
        for (int i = 0; i < servers.length(); i++) {
            JSONObject server = servers.optJSONObject(i); JSONArray vaults = server.optJSONArray("vaults");
            for (int j = 0; j < vaults.length(); j++) if (id.equals(vaults.optJSONObject(j).optString("id"))) return server;
        }
        return null;
    }
    private static void removeConnection(JSONObject config, String id) throws Exception {
        JSONObject owner = serverForVault(config, id);
        if (owner != null) removeById(owner.getJSONArray("vaults"), id);
        JSONArray pending = config.optJSONArray("cleanupJournals");
        if (pending == null) { pending = new JSONArray(); config.put("cleanupJournals", pending); }
        for (int i = 0; i < pending.length(); i++) if (id.equals(pending.optString(i))) return;
        pending.put(id);
    }
    private static void removeById(JSONArray array, String id) {
        for (int i = array.length() - 1; i >= 0; i--) if (id.equals(array.optJSONObject(i).optString("id"))) array.remove(i);
    }
}
