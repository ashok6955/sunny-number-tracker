package com.sunny.numbertracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static final String ACTION_CLIP_COPIED = "com.sunny.numbertracker.CLIP_COPIED";
    private static final String PREFS_NAME = "sunny_bridge_prefs";
    private static final String KEY_PENDING_CLIP = "pending_clip";

    public class SunnyNativeBridge {
        @JavascriptInterface
        public void returnToPreviousApp() {
            runOnUiThread(() -> moveTaskToBack(true));
        }

        @JavascriptInterface
        public String consumePendingClip() {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String pending = prefs.getString(KEY_PENDING_CLIP, null);
            if (pending != null && !pending.trim().isEmpty()) {
                prefs.edit().remove(KEY_PENDING_CLIP).apply();
                return pending;
            }
            return "";
        }
    }

    private final BroadcastReceiver clipReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent != null && ACTION_CLIP_COPIED.equals(intent.getAction())) {
                String text = intent.getStringExtra("clip_text");
                if (text != null && !text.trim().isEmpty()) {
                    storePendingClip(text);
                    deliverPendingClipToWeb();
                }
            }
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new SunnyNativeBridge(), "SunnyNativeBridge");
        }
        IntentFilter filter = new IntentFilter(ACTION_CLIP_COPIED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(clipReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(clipReceiver, filter);
        }
        handleIncomingIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIncomingIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().postDelayed(this::deliverPendingClipToWeb, 450);
        }
    }

    @Override
    public void onDestroy() {
        try {
            unregisterReceiver(clipReceiver);
        } catch (IllegalArgumentException ignored) {}
        super.onDestroy();
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        String text = intent.getStringExtra("clip_text");
        if (text != null && !text.trim().isEmpty()) {
            storePendingClip(text);
            deliverPendingClipToWeb();
        }
    }

    private void storePendingClip(String text) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit().putString(KEY_PENDING_CLIP, text).apply();
    }

    private void deliverPendingClipToWeb() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String pending = prefs.getString(KEY_PENDING_CLIP, null);
        if (pending == null || pending.trim().isEmpty()) return;

        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String quoted = JSONObject.quote(pending);
        String js = "(function(){ return typeof window.receiveSunnyClip === 'function' ? window.receiveSunnyClip(" + quoted + ") : 'WAIT'; })();";
        webView.post(() -> webView.evaluateJavascript(js, value -> {
            if (value != null && value.contains("OK")) {
                prefs.edit().remove(KEY_PENDING_CLIP).apply();
            }
        }));
    }
}
