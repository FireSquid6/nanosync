package org.nanosync.mobile;

import java.util.function.Consumer;
import org.json.JSONArray;

/**
 * Asynchronous UI commands: return promptly without network or filesystem work on the caller.
 * Implementations enforce HTTP policy and report state/errors through AppStore and refresh.
 * Use AppStore.mutate for atomic state edits; listVaults may deliver its result on any thread.
 */
public interface UiActions {
    void addServer(String alias, String url, String password, String deviceName);
    void resumeEnrollment(String serverId);
    void connectVault(String serverId, String vaultId, String name, String rootPath, String recoveryKey);
    void listVaults(String serverId, Consumer<JSONArray> result);
    void syncNow(String connectionId, boolean mobileOverride);
    void settingsChanged();
    void disconnectVault(String connectionId);
    void removeServer(String serverId);
}
