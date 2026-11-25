package com.sunny.numbertracker;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

public class SunnyBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences("sunny_bridge_prefs", Context.MODE_PRIVATE);
        boolean syncEnabled = prefs.getBoolean("bg_sync_enabled", false);
        String topic = prefs.getString("bg_sync_topic", "");
        if (syncEnabled && topic != null && !topic.trim().isEmpty()) {
            Intent svc = new Intent(context, SunnySyncService.class);
            svc.setAction(SunnySyncService.ACTION_START);
            svc.putExtra("topic", topic.trim());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        }
    }
}
