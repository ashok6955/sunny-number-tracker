package com.sunny.numbertracker;

import android.accessibilityservice.AccessibilityService;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

public class SunnyAccessibilityService extends AccessibilityService {
    private static final String PREFS_NAME = "sunny_bridge_prefs";
    private static final String KEY_AUTO_ENABLED = "auto_clipboard_enabled";
    private static final long DEBOUNCE_MS = 1500L;

    private ClipboardManager clipboardManager;
    private long lastLaunchMs = 0L;

    private final ClipboardManager.OnPrimaryClipChangedListener clipListener = () -> {
        triggerOpenForClipboard();
    };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        clipboardManager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboardManager != null) {
            try {
                clipboardManager.addPrimaryClipChangedListener(clipListener);
            } catch (Exception ignored) {}
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        CharSequence pkgCs = event.getPackageName();
        String pkg = pkgCs != null ? pkgCs.toString() : "";
        if (getPackageName().equals(pkg)) return;

        int type = event.getEventType();

        // Detect WhatsApp / WhatsApp Business Copy button click
        if (type == AccessibilityEvent.TYPE_VIEW_CLICKED &&
                ("com.whatsapp".equals(pkg) || "com.whatsapp.w4b".equals(pkg))) {
            if (isCopyEvent(event)) {
                triggerOpenForClipboard();
                return;
            }
        }

        // Detect system "Copied to clipboard" toast/overlay
        if (type == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED) {
            for (CharSequence txt : event.getText()) {
                if (txt != null) {
                    String s = txt.toString().toLowerCase();
                    if (s.contains("copied") || s.contains("कॉपी")) {
                        triggerOpenForClipboard();
                        return;
                    }
                }
            }
        }
    }

    private boolean isCopyEvent(AccessibilityEvent event) {
        CharSequence desc = event.getContentDescription();
        if (desc != null) {
            String d = desc.toString().toLowerCase();
            if (d.contains("copy") || d.contains("कॉपी")) return true;
        }
        for (CharSequence txt : event.getText()) {
            if (txt != null) {
                String t = txt.toString().toLowerCase();
                if (t.contains("copy") || t.contains("कॉपी")) return true;
            }
        }
        AccessibilityNodeInfo src = event.getSource();
        if (src != null) {
            try {
                CharSequence sDesc = src.getContentDescription();
                CharSequence sText = src.getText();
                String combined = ((sDesc != null ? sDesc.toString() : "") + " " +
                        (sText != null ? sText.toString() : "")).toLowerCase();
                if (combined.contains("copy") || combined.contains("कॉपी")) return true;
            } finally {
                src.recycle();
            }
        }
        return false;
    }

    private void triggerOpenForClipboard() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_AUTO_ENABLED, true)) return;

        long now = System.currentTimeMillis();
        if (now - lastLaunchMs < DEBOUNCE_MS) return;
        lastLaunchMs = now;

        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK |
                Intent.FLAG_ACTIVITY_SINGLE_TOP |
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        open.putExtra("from_copy_trigger", true);
        startActivity(open);
    }

    @Override
    public void onInterrupt() {}

    @Override
    public void onDestroy() {
        if (clipboardManager != null) {
            try {
                clipboardManager.removePrimaryClipChangedListener(clipListener);
            } catch (Exception ignored) {}
        }
        super.onDestroy();
    }
}
