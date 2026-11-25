package com.sunny.numbertracker;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static final String PREFS_NAME = "sunny_bridge_prefs";
    private static final String KEY_AUTO_ENABLED = "auto_clipboard_enabled";
    private static final String KEY_LAST_CLIP = "last_seen_clip";

    public class SunnyNativeBridge {
        @JavascriptInterface
        public void returnToPreviousApp() {
            runOnUiThread(() -> moveTaskToBack(true));
        }

        @JavascriptInterface
        public void setAutoEnabled(boolean enabled) {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_AUTO_ENABLED, enabled)
                .apply();
        }

        @JavascriptInterface
        public void readClipboardIfNew() {
            runOnUiThread(() -> checkSystemClipboardAndDeliver());
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new SunnyNativeBridge(), "SunnyNativeBridge");
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().postDelayed(this::checkSystemClipboardAndDeliver, 180);
        }
    }

    private void checkSystemClipboardAndDeliver() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_AUTO_ENABLED, true)) return;

        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) return;
        ClipData clip = cm.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return;

        CharSequence cs = clip.getItemAt(0).coerceToText(this);
        if (cs == null) return;
        String text = cs.toString().trim();
        if (text.isEmpty()) return;

        // Only auto-trigger for new clipboard text that contains at least one digit
        String lastClip = prefs.getString(KEY_LAST_CLIP, "");
        if (text.equals(lastClip)) return;
        if (!text.matches("(?s).*\\d.*")) return;

        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String quoted = JSONObject.quote(text);
        String js = "(function(){ return typeof window.receiveSunnyClip === 'function' ? window.receiveSunnyClip(" + quoted + ") : 'WAIT'; })();";
        webView.evaluateJavascript(js, value -> {
            if (value != null && value.contains("OK")) {
                prefs.edit().putString(KEY_LAST_CLIP, text).apply();
            }
        });
    }
}
