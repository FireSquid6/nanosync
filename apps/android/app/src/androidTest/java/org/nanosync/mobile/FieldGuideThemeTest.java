package org.nanosync.mobile;

import android.app.AlertDialog;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.RippleDrawable;
import android.util.TypedValue;
import android.view.ContextThemeWrapper;
import android.widget.Button;
import android.widget.EditText;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public final class FieldGuideThemeTest {
    @Test public void lightScreensAndDialogsUseFieldGuideColors() {
        checkTheme(Configuration.UI_MODE_NIGHT_NO, "#fbf1c7", "#3c3836", "#9d0006");
    }

    @Test public void darkScreensAndDialogsUseFieldGuideColors() {
        checkTheme(Configuration.UI_MODE_NIGHT_YES, "#282828", "#ebdbb2", "#ff6655");
    }

    private void checkTheme(int nightMode, String background, String text, String accent) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
            Configuration config = new Configuration(target.getResources().getConfiguration());
            config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | nightMode;
            Context themed = new ContextThemeWrapper(
                    target.createConfigurationContext(config), R.style.FieldGuideTheme);
            assertEquals(Color.parseColor(background), themed.getColor(R.color.fg_bg));
            assertEquals(Color.parseColor(text), color(themed, android.R.attr.textColorPrimary));
            Button button = new Button(themed);
            assertEquals(Color.parseColor(accent), button.getCurrentTextColor());
            assertEquals(Typeface.MONOSPACE, button.getTypeface());
            assertTrue(button.getBackground() instanceof RippleDrawable);
            int minimumTouchHeight = Math.round(48 * themed.getResources().getDisplayMetrics().density);
            assertTrue(button.getMinHeight() >= minimumTouchHeight);
            EditText input = new EditText(themed);
            assertEquals(Color.parseColor(text), input.getCurrentTextColor());
            assertEquals(Typeface.MONOSPACE, input.getTypeface());
            AlertDialog dialog = new AlertDialog.Builder(themed).setTitle("Connect vault").create();
            Context dialogTheme = dialog.getContext();
            assertEquals(Color.parseColor(background), color(dialogTheme, android.R.attr.colorBackground));
            assertEquals(Color.parseColor(text), color(dialogTheme, android.R.attr.textColorPrimary));
            assertEquals(Color.parseColor(accent), color(dialogTheme, android.R.attr.colorAccent));
        });
    }

    private int color(Context context, int attribute) {
        TypedValue value = new TypedValue();
        assertTrue(context.getTheme().resolveAttribute(attribute, value, true));
        if (value.resourceId == 0) return value.data;
        return context.getColorStateList(value.resourceId).getDefaultColor();
    }
}
