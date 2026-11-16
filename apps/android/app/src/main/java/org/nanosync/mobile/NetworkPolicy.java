package org.nanosync.mobile;

import android.net.NetworkCapabilities;

/** Shared UI/scheduler/transport classification; Wi-Fi is not the same as unmetered. */
final class NetworkPolicy {
    private NetworkPolicy() { }

    static boolean isWifi(NetworkCapabilities capabilities) {
        // A VPN explicitly reporting Wi-Fi remains Wi-Fi. When its underlying
        // transport is unknown, fail closed and let manual sync ask for an override.
        return capabilities != null && isWifi(
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR));
    }

    static boolean isWifi(boolean wifi, boolean cellular) { return wifi && !cellular; }
}
