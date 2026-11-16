package org.nanosync.mobile;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.List;

import static org.junit.Assert.*;

/** Exercises the native screen through accessible user-visible controls. */
@RunWith(AndroidJUnit4.class)
public final class DashboardTest {
    @Test public void homeGlobalNetworkSettingsAndEnrollmentAreDiscoverable() {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = instrumentation.startActivitySync(intent);
        try {
            // The first launch asks for the global mobile-data default, not a vault override.
            long deadline = SystemClock.uptimeMillis() + 10_000;
            while (SystemClock.uptimeMillis() < deadline) {
                AccessibilityNodeInfo choice = find("Wi-Fi only");
                if (choice != null) { assertTrue(choice.performAction(AccessibilityNodeInfo.ACTION_CLICK)); break; }
                if (find("Settings · network & mobile data") != null) break;
                SystemClock.sleep(50);
            }
            click("Settings · network & mobile data");
            assertNotNull(await("Allow unencrypted HTTP"));
            assertNotNull(await("Global default: allow mobile data"));
            click("Cancel");
            click("Add new server");
            assertNotNull(await("Add server"));
            assertNotNull(await("Server enrollment password"));
            click("Cancel");
            assertNotNull(await("Add new server"));
        } finally {
            instrumentation.runOnMainSync(activity::finish);
            instrumentation.waitForIdleSync();
        }
    }

    private static void click(String text) {
        AccessibilityNodeInfo node = await(text);
        assertNotNull("Missing accessible control: " + text, node);
        while (node != null && !node.isClickable()) node = node.getParent();
        assertNotNull("Control is not clickable: " + text, node);
        assertTrue("Click rejected: " + text, node.performAction(AccessibilityNodeInfo.ACTION_CLICK));
    }
    private static AccessibilityNodeInfo await(String text) {
        long deadline = SystemClock.uptimeMillis() + 10_000;
        do {
            AccessibilityNodeInfo node = find(text);
            if (node != null) return node;
            SystemClock.sleep(50);
        } while (SystemClock.uptimeMillis() < deadline);
        return null;
    }
    private static AccessibilityNodeInfo find(String text) {
        AccessibilityNodeInfo root = InstrumentationRegistry.getInstrumentation().getUiAutomation().getRootInActiveWindow();
        if (root == null) return null;
        List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByText(text);
        return nodes.isEmpty() ? findHint(root, text) : nodes.get(0);
    }
    private static AccessibilityNodeInfo findHint(AccessibilityNodeInfo node, String text) {
        CharSequence hint = node.getHintText();
        if (hint != null && hint.toString().contains(text)) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            AccessibilityNodeInfo found = findHint(child, text);
            if (found != null) return found;
        }
        return null;
    }
}
