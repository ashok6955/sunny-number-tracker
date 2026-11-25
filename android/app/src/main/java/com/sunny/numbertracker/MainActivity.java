package com.sunny.numbertracker;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static final String ACTION_CLIP_COPIED = "com.sunny.numbertracker.CLIP_COPIED";
    private static final String PREFS_NAME = "sunny_bridge_prefs";
    private static final String KEY_PENDING_CLIP = "pending_clip";
    private static final String KEY_AUTO_ENABLED = "auto_clipboard_enabled";
    private static final String KEY_LAST_CLIP = "last_seen_clip";
    private static final String KEY_PENDING_SYNC_JSON = "bg_pending_sync_json";

    private final BroadcastReceiver clipReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            String act = intent.getAction();
            if (ACTION_CLIP_COPIED.equals(act)) {
                String text = intent.getStringExtra("clip_text");
                if (text != null && !text.trim().isEmpty()) {
                    storePendingClip(text);
                    deliverPendingClipToWeb();
                }
            } else if (SunnySyncService.ACTION_SYNC_RECEIVED.equals(act)) {
                String payload = intent.getStringExtra("payload");
                if (payload != null && !payload.isEmpty()) {
                    deliverSyncPayloadToWeb(payload);
                }
            }
        }
    };

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
        public String consumePendingClip() {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String pending = prefs.getString(KEY_PENDING_CLIP, null);
            if (pending != null && !pending.trim().isEmpty()) {
                prefs.edit().remove(KEY_PENDING_CLIP).apply();
                return pending;
            }
            return "";
        }

        @JavascriptInterface
        public void readClipboardIfNew() {
            runOnUiThread(() -> checkSystemClipboardFallback());
        }

        @JavascriptInterface
        public void saveFailedPatternsJson(String json) {
            try {
                java.io.File outFile = new java.io.File(getFilesDir(), "sunny_failed_patterns.json");
                java.io.FileOutputStream fos = new java.io.FileOutputStream(outFile, false);
                fos.write((json == null ? "[]" : json).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                fos.close();
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void startBackgroundSync(String topic) {
            if (topic == null || topic.trim().isEmpty()) return;
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 201);
                }
                Intent svc = new Intent(MainActivity.this, SunnySyncService.class);
                svc.setAction(SunnySyncService.ACTION_START);
                svc.putExtra("topic", topic.trim());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(svc);
                } else {
                    startService(svc);
                }
            });
        }

        @JavascriptInterface
        public void stopBackgroundSync() {
            runOnUiThread(() -> {
                Intent svc = new Intent(MainActivity.this, SunnySyncService.class);
                svc.setAction(SunnySyncService.ACTION_STOP);
                startService(svc);
            });
        }

        @JavascriptInterface
        public String consumePendingBackgroundSync() {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            String raw = prefs.getString(KEY_PENDING_SYNC_JSON, "");
            if (raw != null && !raw.isEmpty()) {
                prefs.edit().remove(KEY_PENDING_SYNC_JSON).apply();
                return raw;
            }
            return "";
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().addJavascriptInterface(new SunnyNativeBridge(), "SunnyNativeBridge");
        }
        IntentFilter filter = new IntentFilter(ACTION_CLIP_COPIED);
        filter.addAction(SunnySyncService.ACTION_SYNC_RECEIVED);
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
            getBridge().getWebView().postDelayed(() -> {
                deliverPendingClipToWeb();
                String bgSync = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_PENDING_SYNC_JSON, "");
                if (bgSync != null && !bgSync.isEmpty()) {
                    deliverSyncPayloadToWeb(bgSync);
                }
            }, 300);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().postDelayed(() -> {
                deliverPendingClipToWeb();
                checkSystemClipboardFallback();
            }, 220);
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
        prefs.edit()
            .putString(KEY_PENDING_CLIP, text)
            .putString(KEY_LAST_CLIP, text.trim())
            .apply();
    }

    private void deliverPendingClipToWeb() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_AUTO_ENABLED, true)) return;

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

    private void deliverSyncPayloadToWeb(String payload) {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WebView webView = getBridge().getWebView();
        String quoted = JSONObject.quote(payload);
        String js = "(function(){ return typeof window.receiveSunnySyncPayload === 'function' ? window.receiveSunnySyncPayload(" + quoted + ") : 'WAIT'; })();";
        webView.post(() -> webView.evaluateJavascript(js, value -> {
            if (value != null && value.contains("OK")) {
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().remove(KEY_PENDING_SYNC_JSON).apply();
            }
        }));
    }

    private void checkSystemClipboardFallback() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_AUTO_ENABLED, true)) return;
        if (prefs.getString(KEY_PENDING_CLIP, null) != null) return;

        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) return;
        ClipData clip = cm.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return;

        CharSequence cs = clip.getItemAt(0).coerceToText(this);
        if (cs == null) return;
        String text = cs.toString().trim();
        if (text.isEmpty()) return;

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
