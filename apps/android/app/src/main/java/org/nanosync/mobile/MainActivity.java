package org.nanosync.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.net.URI;
import java.text.DateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/** Framework-only dashboard. SyncCoordinator owns networking, root validation and runtime work. */
public final class MainActivity extends Activity {
    private static final int PICK_FOLDER = 41;
    private static final int NOTIFICATIONS = 42;
    private String pendingBackground;
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final Set<String> expanded = new HashSet<>();
    private AppStore store;
    private UiActions actions;
    private LinearLayout content;
    private ScrollView scroll;
    private String detailId;
    private Consumer<String> folderResult;
    private boolean onboardingVisible;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        if (state != null) {
            detailId = state.getString("detailId");
            String[] open = state.getStringArray("expanded");
            if (open != null) java.util.Collections.addAll(expanded, open);
        }
        scroll = new ScrollView(this);
        content = column();
        scroll.addView(content);
        setContentView(scroll);
        text(content, "Opening secure settings…", 20);
        storage.execute(() -> {
            try {
                AppStore loaded = AppStore.get(getApplicationContext());
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    store = loaded;
                    actions = new SyncCoordinator(this, store, this::refresh);
                    refresh();
                    command(() -> actions.settingsChanged());
                    onboarding();
                });
            } catch (RuntimeException e) {
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    content.removeAllViews();
                    text(content, "Secure settings unavailable", 22);
                    text(content, "Nanosync could not open its encrypted settings. Unlock your device and reopen the app. If this persists, keep your recovery keys safe before reinstalling or clearing app data.", 16);
                });
            }
        });
    }

    @Override protected void onResume() {
        super.onResume();
        if (actions != null) {
            refresh();
            command(() -> actions.settingsChanged());
            onboarding();
        }
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        out.putString("detailId", detailId);
        out.putStringArray("expanded", expanded.toArray(new String[0]));
    }

    @Override protected void onDestroy() {
        folderResult = null;
        storage.shutdown();
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (detailId != null) { detailId = null; refresh(); }
        else super.onBackPressed();
    }

    /** Safe for coordinator callbacks from any thread. Does not recreate open dialogs. */
    public void refresh() {
        runOnUiThread(() -> {
            if (store == null || isDestroyed()) return;
            int y = scroll.getScrollY();
            JSONObject config = store.snapshot();
            content.removeAllViews();
            JSONObject vault = findVault(config, detailId);
            if (detailId != null && vault != null) showVault(config, vault);
            else { detailId = null; showHome(config); }
            scroll.post(() -> scroll.scrollTo(0, y));
        });
    }

    private void showHome(JSONObject config) {
        LinearLayout header = row(content);
        TextView title = text(header, "Nanosync", 26);
        title.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        button(header, "Add new server", this::addServer);
        button(content, "Settings · network & mobile data", this::settings);
        String globalError = value(config, "error", "");
        if (!globalError.isEmpty()) text(content, "Action error: " + globalError + "\nResolve the issue above and retry the action.", 16);
        JSONArray servers = config.optJSONArray("servers");
        if (servers.length() == 0) text(content, "Add a server to connect an existing remote vault to a folder on this device.", 16);
        for (int i = 0; i < servers.length(); i++) {
            JSONObject server = servers.optJSONObject(i);
            String id = server.optString("id");
            boolean open = expanded.contains(id);
            button(content, (open ? "▾ " : "▸ ") + label(server, "alias", "Server") + " · " + server.optString("enrollmentStatus"), () -> {
                if (!expanded.add(id)) expanded.remove(id);
                refresh();
            });
            if (!open) continue;
            text(content, server.optString("baseUrl"), 14);
            text(content, "Device: " + server.optString("deviceId") + "\nFingerprint: " + server.optString("fingerprint"), 14);
            String error = server.optString("error", "");
            if (!error.isEmpty()) text(content, "Server error: " + error + "\nCheck the server address, connectivity and approval, then retry.", 16);
            button(content, "Resume / check device approval", () -> serverCommand(id, () -> actions.resumeEnrollment(id)));
            button(content, "Connect existing vault", () -> listVaults(id));
            JSONArray vaults = server.optJSONArray("vaults");
            for (int j = 0; j < vaults.length(); j++) {
                JSONObject vault = vaults.optJSONObject(j);
                button(content, "    " + label(vault, "name", "Vault") + " · " + vault.optString("status"), () -> {
                    detailId = vault.optString("id");
                    scroll.scrollTo(0, 0);
                    refresh();
                });
            }
            button(content, "Remove server…", () -> confirm("Remove server?", "Disconnect all vaults on this server and remove its saved credentials. Local folders and their files are left intact.", () -> command(() -> actions.removeServer(id))));
        }
    }

    private void showVault(JSONObject config, JSONObject vault) {
        String id = vault.optString("id");
        button(content, "‹ All servers", () -> { detailId = null; refresh(); });
        text(content, label(vault, "name", "Vault"), 24);
        text(content, "Folder: " + vault.optString("rootPath") + "\nState: " + vault.optString("status")
                + "\nLast success: " + lastSuccess(vault)
                + "\nPending uploads: " + vault.optInt("pendingUploads")
                + " · downloads: " + vault.optInt("pendingDownloads")
                + "\nProgress: " + value(vault, "progress", "Not reported"), 16);
        String error = value(vault, "error", "");
        if (!error.isEmpty()) text(content, "Error: " + error + "\nCheck network access, folder permissions and device approval, then try Sync now.", 16);
        JSONArray conflicts = vault.optJSONArray("conflicts");
        text(content, "Conflicts", 18);
        if (conflicts == null || conflicts.length() == 0) text(content, "None reported", 16);
        else for (int i = 0; i < conflicts.length(); i++) {
            Object conflict = conflicts.opt(i);
            text(content, conflict instanceof JSONObject ? ((JSONObject) conflict).toString() : String.valueOf(conflict), 14);
        }
        check(content, "Paused (automatic sync)", vault.optBoolean("paused"), checked -> editVault(id, v -> put(v, "paused", checked)));
        CheckBox background = check(content, "Background sync (opt in for this vault)", vault.optBoolean("background"), checked -> backgroundChanged(id, checked));
        background.setEnabled(vault.optBoolean("initialSyncComplete"));
        text(content, "Background sync uses an ongoing Android notification while running. Notification permission may be requested.", 14);
        if (!vault.optBoolean("initialSyncComplete")) text(content, "Complete the initial foreground sync before enabling background sync.", 14);
        text(content, "Mobile data policy", 18);
        Spinner policy = new Spinner(this);
        String inherited = config.optBoolean("defaultMobile") ? "allowed" : "Wi-Fi only";
        policy.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item,
                new String[]{"Inherit global (" + inherited + ")", "Allow mobile data", "Wi-Fi only"}));
        String saved = vault.optString("mobilePolicy", "default");
        int selection = saved.equals("allow") ? 1 : saved.equals("wifi") ? 2 : 0;
        policy.setSelection(selection);
        content.addView(policy);
        policy.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            int current = selection;
            @Override public void onItemSelected(AdapterView<?> p, View v, int position, long itemId) {
                if (position == current) return;
                current = position;
                editVault(id, item -> put(item, "mobilePolicy", new String[]{"default", "allow", "wifi"}[position]));
            }
            @Override public void onNothingSelected(AdapterView<?> p) { }
        });
        button(content, "Sync now", () -> syncNow(id));
        text(content, "Sync now does not change paused, background or mobile data preferences.", 14);
        button(content, "Disconnect vault…", () -> confirm("Disconnect vault?", "Remove this connection and its saved recovery key. The local folder and all its files are left intact.", () -> command(() -> actions.disconnectVault(id))));
    }

    private void syncNow(String id) {
        if (!ensureStorageAccess()) return;
        JSONObject config = store.snapshot();
        JSONObject vault = findVault(config, id);
        if (vault == null) return;
        String policy = vault.optString("mobilePolicy", "default");
        boolean allowed = policy.equals("allow") || (policy.equals("default") && config.optBoolean("defaultMobile"));
        ConnectivityManager connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(connectivity.getActiveNetwork());
        boolean wifi = capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        if (!allowed && !wifi) {
            confirm("Use mobile data once?", "This vault is set to Wi-Fi only. Allow this one sync on the current network? Saved preferences will not change.", () -> command(() -> actions.syncNow(id, true)));
        } else command(() -> actions.syncNow(id, false));
    }

    private void onboarding() {
        if (onboardingVisible || store == null || store.snapshot().optBoolean("mobilePrompted")) return;
        onboardingVisible = true;
        new AlertDialog.Builder(this).setTitle("Default mobile data policy")
                .setMessage("May vaults use mobile data by default? Each vault can override this. Background sync is a separate opt-in after initial sync.")
                .setPositiveButton("Allow mobile data", (d, w) -> mobileDefault(true))
                .setNegativeButton("Wi-Fi only", (d, w) -> mobileDefault(false))
                .setCancelable(false).show();
    }

    private void mobileDefault(boolean allow) {
        mutate(config -> { put(config, "defaultMobile", allow); put(config, "mobilePrompted", true); });
        onboardingVisible = false;
    }

    private void settings() {
        JSONObject config = store.snapshot();
        LinearLayout body = column();
        CheckBox http = check(body, "Allow unencrypted HTTP (unsafe)", config.optBoolean("allowHttp"), null);
        text(body, "HTTP exposes credentials and traffic. HTTPS always verifies TLS certificates; this switch never bypasses TLS verification.", 16);
        CheckBox mobile = check(body, "Global default: allow mobile data", config.optBoolean("defaultMobile"), null);
        text(body, "When off, inheriting vaults use Wi-Fi only. Explicit per-vault policies are unchanged.", 16);
        new AlertDialog.Builder(this).setTitle("Settings").setView(body)
                .setNegativeButton("Cancel", null).setPositiveButton("Save", (d, w) -> mutate(current -> {
                    put(current, "allowHttp", http.isChecked());
                    put(current, "defaultMobile", mobile.isChecked());
                    put(current, "mobilePrompted", true);
                })).show();
    }

    private void addServer() {
        LinearLayout body = column();
        EditText alias = input(body, "Server alias", false);
        EditText url = input(body, "https://server.example", false);
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText password = input(body, "Server enrollment password", true);
        EditText device = input(body, "Device name", false);
        device.setText(android.os.Build.MODEL);
        TextView error = text(body, "", 14);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Add server").setView(wrap(body))
                .setNegativeButton("Cancel", null).setPositiveButton("Enroll", null).create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            try {
                String address = validateUrl(url.getText().toString().trim(), store.snapshot().optBoolean("allowHttp"));
                if (alias.getText().toString().trim().isEmpty() || device.getText().toString().trim().isEmpty() || password.length() == 0) {
                    throw new IllegalArgumentException("Enter an alias, device name and enrollment password.");
                }
                String secret = password.getText().toString();
                command(() -> actions.addServer(alias.getText().toString().trim(), address, secret, device.getText().toString().trim()));
                password.setText("");
                dialog.dismiss();
            } catch (IllegalArgumentException e) { error.setText(e.getMessage()); }
        }));
        dialog.setOnDismissListener(d -> password.setText(""));
        dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.show();
    }

    private static String validateUrl(String value, boolean allowHttp) {
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) throw new Exception();
            if (uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null || uri.getQuery() != null
                    || uri.getPort() > 65535 || uri.getPort() == 0) throw new Exception();
            if ("http".equalsIgnoreCase(scheme) && !allowHttp) {
                throw new IllegalArgumentException("HTTP is disabled. Use HTTPS, or explicitly enable Allow HTTP in Settings.");
            }
            return uri.toString();
        } catch (IllegalArgumentException e) { throw e; }
        catch (Exception e) { throw new IllegalArgumentException("Enter a complete HTTP(S) server URL without credentials, query or fragment."); }
    }

    private void listVaults(String serverId) {
        JSONObject config = store.snapshot();
        JSONObject serverConfig = findServer(config, serverId);
        if (serverConfig == null) return;
        try { validateUrl(serverConfig.optString("baseUrl"), config.optBoolean("allowHttp")); }
        catch (IllegalArgumentException e) { message("Server connection blocked", e.getMessage()); return; }
        AlertDialog loading = new AlertDialog.Builder(this).setTitle("Existing remote vaults")
                .setMessage("Loading… If this takes too long, cancel and check the server's enrollment and network status.")
                .setNegativeButton("Cancel", null).show();
        serverCommand(serverId, () -> actions.listVaults(serverId, result -> runOnUiThread(() -> {
            if (isDestroyed() || !loading.isShowing()) return;
            loading.dismiss();
            JSONObject server = findServer(store.snapshot(), serverId);
            if (server == null) return;
            Set<String> connected = new HashSet<>();
            JSONArray local = server.optJSONArray("vaults");
            for (int i = 0; i < local.length(); i++) connected.add(local.optJSONObject(i).optString("vaultId"));
            java.util.ArrayList<JSONObject> available = new java.util.ArrayList<>();
            java.util.ArrayList<String> labels = new java.util.ArrayList<>();
            if (result != null) for (int i = 0; i < result.length(); i++) {
                JSONObject remote = result.optJSONObject(i);
                if (remote == null) continue;
                String id = remote.optString("id", remote.optString("vaultId"));
                if (!id.isEmpty() && !connected.contains(id)) {
                    available.add(remote);
                    labels.add(label(remote, "name", id));
                }
            }
            if (available.isEmpty()) {
                message("No available vaults", "No unconnected remote vaults were returned. Check enrollment and server errors on the dashboard, then retry. Vault creation is not available here.");
                return;
            }
            new AlertDialog.Builder(this).setTitle("Connect existing vault")
                    .setItems(labels.toArray(new String[0]), (d, which) -> connectVault(serverId, available.get(which)))
                    .setNegativeButton("Cancel", null).show();
        })));
    }

    private void connectVault(String serverId, JSONObject remote) {
        String remoteId = remote.optString("id", remote.optString("vaultId"));
        String name = label(remote, "name", remoteId);
        LinearLayout body = column();
        text(body, "Connect “" + name + "” to a shared local folder. Existing files are supported and will be imported/merged by the first sync.", 16);
        TextView folder = text(body, "No folder selected", 16);
        String[] path = {null};
        Consumer<String> selected = value -> { path[0] = value; folder.setText(value); };
        text(body, "Android All files access is required for ordinary-path sync; the selected folder, not all shared storage, is the actual sync scope. A folder-picker grant alone is not sufficient.", 16);
        button(body, "Choose local folder…", () -> {
            if (!ensureStorageAccess()) return;
            folderResult = selected;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            try { startActivityForResult(intent, PICK_FOLDER); }
            catch (RuntimeException e) { folderResult = null; message("Folder picker unavailable", "Install or enable the system Files app and try again."); }
        });
        EditText key = input(body, "Vault recovery key", true);
        TextView error = text(body, "", 14);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Connect vault").setView(wrap(body))
                .setNegativeButton("Cancel", null).setPositiveButton("Connect…", null).create();
        dialog.setOnShowListener(d -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            if (!ensureStorageAccess()) return;
            if (path[0] == null || key.length() == 0) { error.setText("Select a supported local folder and enter the recovery key."); return; }
            confirm("Import and sync this folder?", "Folder: " + path[0] + "\nExisting files will participate in sync with “" + name + "”. Review the folder carefully; use a backup for important existing files. Root permissions and overlaps will be checked before connecting.", () -> {
                String secret = key.getText().toString();
                serverCommand(serverId, () -> actions.connectVault(serverId, remoteId, name, path[0], secret));
                key.setText("");
                dialog.dismiss();
            });
        }));
        dialog.setOnDismissListener(d -> { key.setText(""); if (folderResult == selected) folderResult = null; });
        dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.show();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FOLDER) return;
        Consumer<String> callback = folderResult;
        folderResult = null;
        if (result != RESULT_OK || data == null || callback == null) return;
        Uri uri = data.getData();
        int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        storage.execute(() -> {
            try {
                String path = resolvePrimaryTree(uri);
                try { getContentResolver().takePersistableUriPermission(uri, flags); }
                catch (SecurityException ignored) { /* Broad filesystem permission is checked by runtime. */ }
                runOnUiThread(() -> { if (!isDestroyed()) callback.accept(path); });
            } catch (Exception e) {
                runOnUiThread(() -> { if (!isDestroyed()) message("Unsupported folder", "Choose a folder under Internal storage in the system Files picker. Cloud providers, Downloads, SD cards and non-primary volumes are not supported. Shared-storage access must also be granted before sync."); });
            }
        });
    }

    private static String resolvePrimaryTree(Uri uri) throws Exception {
        if (uri == null || !"content".equals(uri.getScheme())
                || !"com.android.externalstorage.documents".equals(uri.getAuthority())
                || !DocumentsContract.isTreeUri(uri)) throw new IllegalArgumentException();
        String id = DocumentsContract.getTreeDocumentId(uri);
        if (!id.startsWith("primary:")) throw new IllegalArgumentException();
        String relative = id.substring("primary:".length());
        if (relative.startsWith("/") || relative.indexOf('\0') >= 0) throw new IllegalArgumentException();
        for (String segment : relative.split("/")) if (segment.equals("..") || segment.equals(".")) throw new IllegalArgumentException();
        File root = new File("/storage/emulated/0").getCanonicalFile();
        File target = new File(root, relative).getCanonicalFile();
        if (!target.equals(root) && !target.toPath().startsWith(root.toPath())) throw new IllegalArgumentException();
        return target.getPath();
    }

    private boolean ensureStorageAccess() {
        if (android.os.Build.VERSION.SDK_INT < 30 || android.os.Environment.isExternalStorageManager()) return true;
        new AlertDialog.Builder(this).setTitle("Allow shared-storage access")
                .setMessage("Nanosync needs Android's All files access to sync ordinary local file paths. The folder you choose remains the actual sync scope; this grant does not connect other folders. A system folder-picker grant alone is not enough. Enable access in Android Settings, then return and choose/connect the folder again.")
                .setNegativeButton("Cancel", null).setPositiveButton("Open Android Settings", (d, w) -> {
                    try {
                        startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                                Uri.parse("package:" + getPackageName())));
                    } catch (RuntimeException e) {
                        message("Open Android Settings", "Go to Settings → Special app access → All files access → Nanosync, enable access, then return here.");
                    }
                }).show();
        return false;
    }

    private void backgroundChanged(String id, boolean enabled) {
        if (!enabled) { editVault(id, vault -> put(vault, "background", false)); return; }
        refresh(); // Permission/confirmation is not a saved preference yet.
        JSONObject vault = findVault(store.snapshot(), id);
        if (vault == null || !vault.optBoolean("initialSyncComplete")) return;
        confirm("Enable background sync?", "This vault may sync while the app is closed. Android displays an ongoing notification while sync runs. Mobile data and paused preferences still apply.", () -> {
            if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                pendingBackground = id;
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, NOTIFICATIONS);
            } else enableBackground(id);
        });
    }

    private void enableBackground(String id) {
        editVault(id, vault -> {
            if (vault.optBoolean("initialSyncComplete")) put(vault, "background", true);
        });
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(requestCode, permissions, grants);
        if (requestCode != NOTIFICATIONS) return;
        String id = pendingBackground;
        pendingBackground = null;
        if (id == null) return;
        if (grants.length > 0 && grants[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            enableBackground(id);
        } else {
            new AlertDialog.Builder(this).setTitle("Background sync not enabled")
                    .setMessage("Allow Nanosync notifications in Android Settings, then enable background sync here again. Foreground Sync now is still available.")
                    .setNegativeButton("Not now", null).setPositiveButton("Notification settings", (d, w) -> {
                        try {
                            startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                    .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName()));
                        } catch (RuntimeException e) { message("Open Android Settings", "Open Nanosync's app settings and allow notifications."); }
                    }).show();
        }
    }

    private void editVault(String id, Consumer<JSONObject> edit) {
        mutate(config -> {
            JSONObject vault = findVault(config, id);
            if (vault != null) edit.accept(vault);
        });
    }

    private void mutate(Consumer<JSONObject> edit) {
        storage.execute(() -> {
            try {
                store.mutate(edit);
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    refresh();
                    command(() -> actions.settingsChanged());
                });
            } catch (RuntimeException e) {
                runOnUiThread(() -> { if (!isDestroyed()) message("Settings not saved", "Check free device storage and retry. Your previous saved settings are unchanged."); });
            }
        });
    }

    private void serverCommand(String serverId, Runnable action) {
        JSONObject config = store.snapshot();
        JSONObject server = findServer(config, serverId);
        if (server == null) return;
        try { validateUrl(server.optString("baseUrl"), config.optBoolean("allowHttp")); }
        catch (IllegalArgumentException e) { message("Server connection blocked", e.getMessage()); return; }
        command(action);
    }

    private void command(Runnable action) {
        try { action.run(); }
        catch (RuntimeException e) { message("Action could not start", "Check connectivity, device approval and folder access, then retry. Any additional server or vault error appears on the dashboard."); }
    }

    private static JSONObject findServer(JSONObject config, String id) {
        JSONArray servers = config.optJSONArray("servers");
        for (int i = 0; i < servers.length(); i++) {
            JSONObject server = servers.optJSONObject(i);
            if (server.optString("id").equals(id)) return server;
        }
        return null;
    }

    private static JSONObject findVault(JSONObject config, String id) {
        if (id == null) return null;
        JSONArray servers = config.optJSONArray("servers");
        for (int i = 0; i < servers.length(); i++) {
            JSONArray vaults = servers.optJSONObject(i).optJSONArray("vaults");
            for (int j = 0; j < vaults.length(); j++) {
                JSONObject vault = vaults.optJSONObject(j);
                if (vault.optString("id").equals(id)) return vault;
            }
        }
        return null;
    }

    private static void put(JSONObject object, String key, Object value) {
        try { object.put(key, value); }
        catch (JSONException e) { throw new IllegalArgumentException("Invalid setting", e); }
    }

    private static String label(JSONObject value, String key, String fallback) {
        String label = value.optString(key, "");
        return label.isEmpty() ? fallback : label;
    }

    private static String value(JSONObject object, String key, String fallback) {
        return object.isNull(key) || object.optString(key).isEmpty() ? fallback : object.optString(key);
    }

    private static String lastSuccess(JSONObject vault) {
        Object time = vault.opt("lastSuccess");
        if (time instanceof Number && ((Number) time).longValue() > 0) {
            return DateFormat.getDateTimeInstance().format(new Date(((Number) time).longValue()));
        }
        return value(vault, "lastSuccess", "Never");
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (16 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);
        return layout;
    }

    private LinearLayout row(LinearLayout parent) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        layout.setGravity(android.view.Gravity.CENTER_VERTICAL);
        parent.addView(layout);
        return layout;
    }

    private ScrollView wrap(LinearLayout body) {
        ScrollView view = new ScrollView(this);
        view.addView(body);
        return view;
    }

    private TextView text(LinearLayout parent, String value, int size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setPadding(0, 8, 0, 8);
        view.setTextIsSelectable(true);
        parent.addView(view);
        return view;
    }

    private void button(LinearLayout parent, String label, Runnable action) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        view.setOnClickListener(v -> action.run());
        parent.addView(view);
    }

    private CheckBox check(LinearLayout parent, String label, boolean checked, Consumer<Boolean> change) {
        CheckBox view = new CheckBox(this);
        view.setText(label);
        view.setChecked(checked);
        if (change != null) view.setOnCheckedChangeListener((button, value) -> change.accept(value));
        parent.addView(view);
        return view;
    }

    private EditText input(LinearLayout parent, String hint, boolean secret) {
        EditText view = new EditText(this);
        view.setHint(hint);
        view.setSingleLine(true);
        view.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_CAP_SENTENCES));
        if (secret) {
            view.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
            view.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
            view.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
            view.setSaveEnabled(false);
            view.setLongClickable(false);
        }
        parent.addView(view);
        return view;
    }

    private void confirm(String title, String message, Runnable yes) {
        new AlertDialog.Builder(this).setTitle(title).setMessage(message)
                .setNegativeButton("Cancel", null).setPositiveButton("Continue", (d, w) -> yes.run()).show();
    }

    private void message(String title, String message) {
        if (!isDestroyed()) new AlertDialog.Builder(this).setTitle(title).setMessage(message).setPositiveButton("OK", null).show();
    }
}
