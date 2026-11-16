package org.nanosync.mobile;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.util.AtomicFile;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/** Service-owned, replaceable computation worker, never a UI or background scheduler.
 * Requires a bundled engine.html/engine.js and a WebView with WebCrypto, Streams and encoders.
 * Service lifecycle/foreground execution/native deadlines are the coordinator's responsibility.
 * No successful completion is synthesized. Renderer loss, unsupported features, missing assets,
 * storage failures and network-policy failures are errors. Background WebView feasibility, real
 * TLS/storage behavior and process-death recovery require device validation before shipping.
 * Master-key JSON exists transiently in the renderer; destroying it is not a guaranteed memory wipe.
 */
public final class EngineRuntime {
    public interface Listener {
        void onEvent(JSONObject event);
        void onFinished(JSONObject result);
        void onError(String message);
    }
    private static final String PAGE = "https://appassets.androidplatform.net/assets/engine.html";
    private static final String SCRIPT = "https://appassets.androidplatform.net/assets/engine.js";
    private static final String CSP = "default-src 'none'; script-src 'self'; frame-src 'none'; connect-src 'none'; "
        + "object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'";
    private static final int MAX_METADATA = 64 * 1024 * 1024;
    private final Context context;
    private final File journalDirectory;
    private final JSONObject server;
    private final JSONObject vault;
    private final boolean allowHttp;
    private final boolean mobileOverride;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    // A bounded single-worker queue avoids unbounded work/memory from the renderer.
    private final ExecutorService executor = new java.util.concurrent.ThreadPoolExecutor(1, 1, 0,
        java.util.concurrent.TimeUnit.MILLISECONDS, new java.util.concurrent.ArrayBlockingQueue<>(32));
    private final AtomicBoolean started = new AtomicBoolean();
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Object journalLock = new Object();
    private volatile HttpURLConnection activeHttp;
    private volatile FolderAccess folder;
    private volatile AtomicFile journal;
    private volatile URI origin;
    // Accessed ONLY on the main looper. closed is the generation token: instances are single-use.
    private WebView webView;
    private boolean invoked;

    public EngineRuntime(Context context, File journalDirectory, JSONObject server, JSONObject vault,
            boolean allowHttp, boolean mobileOverride, Listener listener) {
        this.context = context.getApplicationContext();
        this.journalDirectory = journalDirectory;
        try {
            this.server = new JSONObject(server.toString());
            this.vault = new JSONObject(vault.toString());
        } catch (Exception e) { throw new IllegalArgumentException("Invalid engine configuration", e); }
        this.allowHttp = allowHttp;
        this.mobileOverride = mobileOverride;
        this.listener = java.util.Objects.requireNonNull(listener);
    }

    public void start() {
        if (!started.compareAndSet(false, true) || closed.get()) return;
        try { executor.execute(() -> {
            try {
                File directory = FolderAccess.validateJournalDirectory(context, journalDirectory);
                journal = new AtomicFile(new File(directory, "state.json"));
                origin = validateOrigin(server.getString("baseUrl"), allowHttp);
                folder = new FolderAccess(context, new File(vault.getString("rootPath")), directory);
                main.post(() -> { if (!closed.get()) createWorker(); });
            } catch (Exception e) { error(safeError(e)); }
        }); } catch (RejectedExecutionException ignored) { /* cancellation raced start */ }
    }

    public void cancel() { terminate(() -> listener.onError("Synchronization cancelled")); }

    /** A terminal callback transfers ownership back to the coordinator, so it must be LAST.
     * Never await our executor on its own worker or block the main looper waiting for renderer I/O.
     * A stuck platform operation intentionally retains ownership rather than permitting overlap.
     */
    private void terminate(Runnable callback) {
        if (!closed.compareAndSet(false, true)) return;
        executor.shutdownNow();
        java.util.concurrent.CountDownLatch destroyed = new java.util.concurrent.CountDownLatch(1);
        main.post(() -> {
            try {
                if (webView != null) {
                    WebView worker = webView;
                    webView = null;
                    try { worker.stopLoading(); worker.removeJavascriptInterface("NanosyncNative"); }
                    finally { worker.destroy(); }
                }
            } finally { destroyed.countDown(); }
        });
        Thread cleanup = new Thread(() -> {
            HttpURLConnection connection = activeHttp;
            if (connection != null) {
                try { connection.disconnect(); }
                catch (RuntimeException ignored) { /* still wait for the bounded I/O to really exit */ }
            }
            boolean interrupted = false;
            for (;;) {
                try {
                    if (executor.awaitTermination(1, java.util.concurrent.TimeUnit.SECONDS)) break;
                } catch (InterruptedException e) { interrupted = true; }
            }
            // sync journal writes run on WebView's bridge thread, not our executor.
            synchronized (journalLock) { /* wait for any in-flight atomic journal write */ }
            for (;;) {
                try { destroyed.await(); break; }
                catch (InterruptedException e) { interrupted = true; }
            }
            main.post(callback);
            if (interrupted) Thread.currentThread().interrupt();
        }, "nanosync-engine-close");
        cleanup.setDaemon(true);
        cleanup.start();
    }

    private void error(String message) { terminate(() -> listener.onError(message)); }

    private void finished(JSONObject result) { terminate(() -> listener.onFinished(result)); }

    private void createWorker() {
        try {
            WebView.setWebContentsDebuggingEnabled(false);
            webView = new WebView(context);
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            settings.setAllowFileAccessFromFileURLs(false);
            settings.setAllowUniversalAccessFromFileURLs(false);
            settings.setDomStorageEnabled(false);
            settings.setDatabaseEnabled(false);
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            settings.setBlockNetworkLoads(true);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setSupportMultipleWindows(true);
            settings.setGeolocationEnabled(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            webView.setDownloadListener((url, ua, disposition, mime, size) -> error("Downloads are forbidden"));
            webView.setWebChromeClient(new WebChromeClient() {
                @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message message) {
                    error("Popups are forbidden"); return false;
                }
                @Override public void onPermissionRequest(android.webkit.PermissionRequest request) { request.deny(); }
            });
            webView.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    return asset(request.getUrl().toString(), request.getMethod());
                }
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, String url) { return asset(url, "GET"); }
                @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
                @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return true; }
                @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError sslError) {
                    handler.cancel(); error("Unexpected WebView TLS request");
                }
                @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    error("Engine renderer died; run did not complete"); return true;
                }
                @Override public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError failure) {
                    error("Bundled engine could not load");
                }
                @Override public void onPageFinished(WebView view, String url) {
                    if (closed.get() || invoked) return;
                    if (!PAGE.equals(url)) { error("Unexpected engine page"); return; }
                    invoked = true;
                    try {
                        JSONObject configuration = new JSONObject().put("server", server).put("vault", vault)
                            .put("allowHttp", allowHttp).put("mobileOverride", mobileOverride);
                        // JSON.parse(quoted JSON) prevents any configuration/file contents becoming source.
                        String script = "(async()=>{try{if(!window.isSecureContext||!window.crypto||!window.crypto.subtle"
                            + "||typeof ReadableStream!=='function'||typeof WritableStream!=='function'"
                            + "||typeof TransformStream!=='function'||typeof TextEncoder!=='function'"
                            + "||typeof TextDecoder!=='function'||!window.Nanosync||typeof window.Nanosync.run!=='function')"
                            + "throw new Error('Required WebCrypto/Streams/encoding engine features unavailable');"
                            + "await window.Nanosync.run(JSON.parse(" + quote(configuration.toString()) + "));"
                            + "}catch(e){NanosyncNative.fail(String(e&&e.message||e));}})()";
                        view.evaluateJavascript(script, null);
                    } catch (Exception e) { error(safeError(e)); }
                }
            });
            webView.addJavascriptInterface(new Bridge(), "NanosyncNative");
            webView.loadUrl(PAGE);
        } catch (Exception e) { error("Cannot create engine worker: " + safeError(e)); }
    }

    private WebResourceResponse asset(String url, String method) {
        if (!closed.get() && "GET".equals(method) && (PAGE.equals(url) || SCRIPT.equals(url))) {
            try {
                InputStream body = context.getAssets().open(PAGE.equals(url) ? "engine.html" : "engine.js");
                Map<String, String> headers = new LinkedHashMap<>();
                headers.put("Content-Security-Policy", CSP);
                headers.put("X-Content-Type-Options", "nosniff");
                headers.put("Cache-Control", "no-store");
                return new WebResourceResponse(PAGE.equals(url) ? "text/html" : "application/javascript", "UTF-8",
                    200, "OK", headers, body);
            } catch (IOException e) { error("Bundled engine asset missing"); }
        }
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Collections.emptyMap(),
            new ByteArrayInputStream(new byte[0]));
    }

    private static String quote(String value) {
        return JSONObject.quote(value).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
    }
    private static String safeError(Exception e) {
        // Do not return URLs, tokens, file bodies or exception traces across the bridge.
        return e instanceof org.json.JSONException ? "Invalid bridge JSON" :
            e instanceof SecurityException ? "Platform permission denied" :
            e instanceof IOException ? "I/O operation failed: " + e.getClass().getSimpleName() :
            "Operation failed: " + e.getClass().getSimpleName();
    }
    private static JSONObject ok(Object value) throws Exception { return new JSONObject().put("ok", true).put("value", value); }
    private static JSONObject failure(String message) {
        try { return new JSONObject().put("ok", false).put("error", message); }
        catch (Exception impossible) { throw new AssertionError(impossible); }
    }

    public final class Bridge {
        @JavascriptInterface public String sync(String method, String json) {
            try {
                if (closed.get() || journal == null) return failure("Runtime is closed or not ready").toString();
                if (json == null || json.length() > MAX_METADATA + 1024) throw new IOException("Journal request too large");
                JSONObject input = new JSONObject(json);
                synchronized (journalLock) {
                    if (closed.get()) return failure("Runtime is closed").toString();
                    if ("journalRead".equals(method)) {
                        if (!journal.getBaseFile().exists() && !new File(journal.getBaseFile() + ".bak").exists())
                            return ok(new JSONObject()).toString();
                        try (InputStream in = journal.openRead()) {
                            return ok(new JSONObject(new String(readBounded(in, MAX_METADATA), StandardCharsets.UTF_8))).toString();
                        }
                    }
                    if ("journalWrite".equals(method)) {
                        byte[] bytes = input.getJSONObject("state").toString().getBytes(StandardCharsets.UTF_8);
                        if (bytes.length > MAX_METADATA) throw new IOException("Journal too large");
                        FileOutputStream out = null;
                        try {
                            out = journal.startWrite(); out.write(bytes); out.getFD().sync(); journal.finishWrite(out);
                        } catch (Exception e) { if (out != null) journal.failWrite(out); throw e; }
                        return ok(JSONObject.NULL).toString();
                    }
                    return failure("Unknown synchronous method").toString();
                }
            } catch (Exception e) { return failure(safeError(e)).toString(); }
        }

        @JavascriptInterface public void request(String method, String json, String requestId) {
            if (closed.get()) return;
            if (requestId == null || requestId.length() > 256) { error("Invalid bridge request identifier"); return; }
            if (json == null || json.length() > (MAX_METADATA * 4L / 3) + 65536) {
                complete(requestId, failure("Request JSON exceeds bound")); return;
            }
            try {
                executor.execute(() -> {
                    if (closed.get()) return;
                    JSONObject response;
                    try { response = ok(dispatch(method, new JSONObject(json))); }
                    catch (Exception e) { response = failure(safeError(e)); }
                    complete(requestId, response);
                });
            } catch (RejectedExecutionException e) { complete(requestId, failure("Engine request queue is full")); }
        }
        @JavascriptInterface public void event(String json) {
            if (closed.get()) return;
            try {
                if (json == null || json.length() > 1024 * 1024) throw new IOException("Event too large");
                JSONObject value = new JSONObject(json);
                main.post(() -> { if (!closed.get()) listener.onEvent(value); });
            } catch (Exception e) { error("Invalid engine event"); }
        }
        @JavascriptInterface public void finish(String json) {
            if (closed.get()) return;
            try {
                if (json == null || json.length() > MAX_METADATA) throw new IOException("Completion too large");
                finished(new JSONObject(json));
            }
            catch (Exception e) { error("Invalid engine completion"); }
        }
        @JavascriptInterface public void fail(String message) {
            error(message == null ? "Engine failed" : message.substring(0, Math.min(message.length(), 2048)));
        }
    }

    private void complete(String requestId, JSONObject response) {
        main.post(() -> {
            if (!closed.get() && webView != null) webView.evaluateJavascript(
                "window.NanosyncBridge.complete(" + quote(requestId) + ",JSON.parse(" + quote(response.toString()) + "))", null);
        });
    }

    private Object dispatch(String method, JSONObject input) throws Exception {
        if (closed.get() || folder == null) throw new IOException("Runtime closed");
        folder.checkAccessible();
        switch (method) {
            case "http": return http(input);
            case "list": return folder.list();
            case "listDirectory": return folder.listDirectory(input.getString("path"));
            case "read": return folder.read(input.getString("path"), input.getLong("offset"), input.getInt("length"));
            case "digest": return folder.digest(input.getString("path"));
            case "stat": return folder.stat(input.getString("path"));
            case "mkdir": folder.mkdir(input.getString("path")); break;
            case "stageRead": return folder.stageRead(input.getString("id"), input.getLong("offset"), input.getInt("length"));
            case "stageDigest": return folder.stageDigest(input.getString("id"));
            case "stageWrite": folder.stageWrite(input.getString("id"), input.getLong("offset"), input.getString("dataBase64")); break;
            case "stageCommit": folder.stageCommit(input.getString("id"), input.getString("path"), input.optJSONObject("expected")); break;
            case "stageDelete": folder.stageDelete(input.getString("id")); break;
            case "remove": folder.remove(input.getString("path"), input.optJSONObject("expected")); break;
            case "move": folder.move(input.getString("from"), input.getString("to"), input.optJSONObject("expected")); break;
            case "capacity": return folder.capacityInfo();
            default: throw new IllegalArgumentException("Unknown asynchronous method");
        }
        return JSONObject.NULL;
    }

    static URI validateOrigin(String value, boolean allowHttp) throws Exception {
        URI uri = new URI(value);
        String scheme = uri.getScheme();
        if (!("https".equals(scheme) || allowHttp && "http".equals(scheme)) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath())) || uri.getPort() == 0 || uri.getPort() > 65535)
            throw new IOException("Server must be a fixed HTTPS origin (HTTP requires explicit opt-in)");
        return new URI(scheme, null, uri.getHost(), uri.getPort(), "/", null, null);
    }

    static URI resolveRequest(URI origin, String path) throws Exception {
        URI relative = new URI(path);
        if (!path.startsWith("/v1/") || path.indexOf('\\') >= 0 || relative.isAbsolute()
                || relative.getRawAuthority() != null || relative.getRawFragment() != null
                || !relative.normalize().equals(relative) || path.toLowerCase(Locale.ROOT).matches(".*%(2e|2f|5c|00).*"))
            throw new IOException("Only relative /v1/ API requests are allowed");
        URI target = origin.resolve(relative);
        if (!origin.getScheme().equals(target.getScheme()) || !origin.getHost().equals(target.getHost())
                || origin.getPort() != target.getPort()) throw new IOException("Origin mismatch");
        return target;
    }

    private Network checkNetworkPolicy() throws IOException {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        Network active = manager.getActiveNetwork();
        NetworkCapabilities caps = active == null ? null : manager.getNetworkCapabilities(active);
        if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) throw new IOException("Network unavailable");
        boolean mobileAllowed = mobileOverride || vault.optBoolean("effectiveMobileAllowed", false);
        if (!mobileAllowed && (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)))
            throw new IOException("Wi-Fi connection required");
        return active;
    }

    private JSONObject http(JSONObject input) throws Exception {
        Network network = checkNetworkPolicy();
        URI target = resolveRequest(origin, input.getString("path"));
        if (!"https".equals(target.getScheme()) && !allowHttp) throw new IOException("HTTP is disabled");
        String method = input.getString("method").toUpperCase(Locale.ROOT);
        if (!java.util.Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD").contains(method))
            throw new IOException("Unsupported HTTP method");
        HttpURLConnection connection = (HttpURLConnection) network.openConnection(target.toURL());
        activeHttp = connection;
        try {
            if (closed.get()) throw new IOException("Cancelled");
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setUseCaches(false);
            connection.setRequestMethod(method);
            connection.setRequestProperty("Accept-Encoding", "identity");
            Long declaredLength = null;
            JSONObject headers = input.optJSONObject("headers");
            if (headers != null) {
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next(), value = headers.getString(key), lower = key.toLowerCase(Locale.ROOT);
                    if (!java.util.Arrays.asList("authorization", "content-type", "accept", "if-match", "if-none-match", "x-nanosync-vault-id",
                            "content-length", "x-nanosync-protocol-version", "x-nanosync-object-format-version",
                            "x-nanosync-ciphertext-sha256", "idempotency-key").contains(lower)
                            || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0 || value.length() > 16384)
                        throw new IOException("Unsupported request header");
                    // Authorization is forwarded only after independent origin validation above.
                    if (lower.equals("content-length")) {
                        declaredLength = Long.parseLong(value);
                        if (declaredLength < 0) throw new IOException("Invalid content length");
                    } else connection.setRequestProperty(key, value);
                }
            }
            int limit = target.getPath().startsWith("/v1/objects/chunk/") ? FolderAccess.MAX_CHUNK + 96 : MAX_METADATA;
            if (input.has("bodyBase64")) {
                String encoded = input.getString("bodyBase64");
                if (encoded.length() > ((limit + 2L) / 3) * 4) throw new IOException("Request body too large");
                byte[] body = Base64.decode(encoded, Base64.DEFAULT);
                if (body.length > limit || declaredLength != null && declaredLength != body.length)
                    throw new IOException("Invalid request body length");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                checkNetworkPolicy();
                try (java.io.OutputStream out = connection.getOutputStream()) { out.write(body); }
            } else if (declaredLength != null && declaredLength != 0) throw new IOException("Missing request body");
            checkNetworkPolicy();
            int status = connection.getResponseCode();
            if (status >= 300 && status <= 399) throw new IOException("Redirects are forbidden");
            if (connection.getContentLengthLong() > limit) throw new IOException("Response body too large");
            JSONObject responseHeaders = new JSONObject();
            int headerBytes = 0;
            for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                if (header.getKey() != null) {
                    String value = String.join(", ", header.getValue());
                    headerBytes += header.getKey().length() + value.length();
                    if (headerBytes > 65536) throw new IOException("Response headers exceed bound");
                    responseHeaders.put(header.getKey().toLowerCase(Locale.ROOT), value);
                }
            }
            byte[] body;
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) body = new byte[0];
            else try (InputStream in = stream) { body = readBounded(in, limit); }
            if (closed.get()) throw new IOException("Cancelled");
            checkNetworkPolicy();
            return new JSONObject().put("status", status).put("headers", responseHeaders)
                .put("bodyBase64", Base64.encodeToString(body, Base64.NO_WRAP));
        } finally {
            connection.disconnect();
            activeHttp = null;
        }
    }

    private static byte[] readBounded(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[64 * 1024];
        int n;
        while ((n = in.read(buffer)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Cancelled");
            if (n > limit - out.size()) throw new IOException("Response exceeds bound");
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }
}
