package com.sunny.numbertracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.inputmethodservice.InputMethodService;
import android.os.Build;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import android.widget.LinearLayout;
import android.widget.TextView;

public class SunnyKeyboardService extends InputMethodService {
    private static final String PREFS_NAME = "sunny_bridge_prefs";
    private static final String KEY_LIVE_STATS = "live_stats_summary";

    private TextView statsView;
    private boolean isUpper = false;

    private final BroadcastReceiver statsReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            refreshStatsBar();
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        IntentFilter filter = new IntentFilter(SunnySyncService.ACTION_UPDATE_STATS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statsReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(statsReceiver, filter);
        }
    }

    @Override
    public View onCreateInputView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0B141A"));
        int pad = dp(6);
        root.setPadding(pad, pad, pad, dp(10));

        // Top Live Stats Strip (👑 Highest + 💰 Total + App + Switch Keyboard)
        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable barBg = new GradientDrawable();
        barBg.setColor(Color.parseColor("#202C33"));
        barBg.setCornerRadius(dp(8));
        barBg.setStroke(dp(1), Color.parseColor("#00A884"));
        topBar.setBackground(barBg);
        topBar.setPadding(dp(8), dp(6), dp(6), dp(6));

        statsView = new TextView(this);
        statsView.setTextColor(Color.parseColor("#E9EDEF"));
        statsView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        statsView.setSingleLine(true);
        LinearLayout.LayoutParams statsLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        topBar.addView(statsView, statsLp);

        TextView appBtn = makeActionChip("App", "#005C4B");
        appBtn.setOnClickListener(v -> {
            Intent open = new Intent(this, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(open);
        });
        topBar.addView(appBtn);

        TextView imeBtn = makeActionChip("🌐", "#2A3942");
        imeBtn.setOnClickListener(v -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.showInputMethodPicker();
        });
        topBar.addView(imeBtn);

        LinearLayout.LayoutParams topLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        topLp.bottomMargin = dp(6);
        root.addView(topBar, topLp);

        // Number Row
        root.addView(buildKeyRow(new String[]{"1", "2", "3", "4", "5", "6", "7", "8", "9", "0"}));
        // QWERTY Rows
        root.addView(buildKeyRow(new String[]{"q", "w", "e", "r", "t", "y", "u", "i", "o", "p"}));
        root.addView(buildKeyRow(new String[]{"a", "s", "d", "f", "g", "h", "j", "k", "l", "="}));
        root.addView(buildKeyRow(new String[]{"⇧", "z", "x", "c", "v", "b", "n", "m", ".", "⌫"}));
        root.addView(buildBottomRow());

        refreshStatsBar();
        return root;
    }

    @Override
    public void onStartInputView(EditorInfo info, boolean restarting) {
        super.onStartInputView(info, restarting);
        refreshStatsBar();
    }

    private void refreshStatsBar() {
        if (statsView == null) return;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String summary = prefs.getString(KEY_LIVE_STATS, "👑 — • Total: ₹0");
        statsView.post(() -> statsView.setText(summary));
    }

    private TextView makeActionChip(String label, String bgHex) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        tv.setPadding(dp(8), dp(4), dp(8), dp(4));
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(Color.parseColor(bgHex));
        gd.setCornerRadius(dp(6));
        tv.setBackground(gd);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(4);
        tv.setLayoutParams(lp);
        return tv;
    }

    private LinearLayout buildKeyRow(String[] keys) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rowLp.bottomMargin = dp(5);
        row.setLayoutParams(rowLp);

        for (String k : keys) {
            TextView btn = makeKeyButton(k, 1f, "#202C33");
            btn.setOnClickListener(v -> handleKeyPress(k));
            row.addView(btn);
        }
        return row;
    }

    private LinearLayout buildBottomRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);

        String[] labels = {",", "-", "Space", "*", "↵"};
        float[] weights = {1f, 1f, 3.5f, 1f, 1.5f};
        for (int i = 0; i < labels.length; i++) {
            final String lbl = labels[i];
            String bg = "↵".equals(lbl) ? "#00A884" : "#202C33";
            TextView btn = makeKeyButton(lbl, weights[i], bg);
            btn.setOnClickListener(v -> handleKeyPress(lbl));
            row.addView(btn);
        }
        return row;
    }

    private TextView makeKeyButton(String label, float weight, String bgHex) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextColor(Color.parseColor("#E9EDEF"));
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(0, dp(10), 0, dp(10));
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(Color.parseColor(bgHex));
        gd.setCornerRadius(dp(6));
        tv.setBackground(gd);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, weight);
        lp.leftMargin = dp(2);
        lp.rightMargin = dp(2);
        tv.setLayoutParams(lp);
        return tv;
    }

    private void handleKeyPress(String key) {
        InputConnection ic = getCurrentInputConnection();
        if (ic == null) return;
        if ("⌫".equals(key)) {
            ic.deleteSurroundingText(1, 0);
        } else if ("Space".equals(key)) {
            ic.commitText(" ", 1);
        } else if ("↵".equals(key)) {
            ic.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER));
            ic.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER));
        } else if ("⇧".equals(key)) {
            isUpper = !isUpper;
        } else {
            String out = isUpper ? key.toUpperCase() : key;
            ic.commitText(out, 1);
        }
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    @Override
    public void onDestroy() {
        try {
            unregisterReceiver(statsReceiver);
        } catch (IllegalArgumentException ignored) {}
        super.onDestroy();
    }
}
