package org.nanosync.mobile;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class NetworkPolicyTest {
    @Test public void wifiDoesNotRequireAnUnmeteredOrNonVpnNetwork() {
        // Metered/VPN flags intentionally do not override an explicit Wi-Fi transport.
        assertTrue(NetworkPolicy.isWifi(true, false));
    }
    @Test public void cellularAndUnknownUnderlyingTransportNeedAnException() {
        assertFalse(NetworkPolicy.isWifi(null));
        assertFalse(NetworkPolicy.isWifi(false, true));
        assertFalse(NetworkPolicy.isWifi(false, false));
        assertFalse(NetworkPolicy.isWifi(true, true));
    }
}
