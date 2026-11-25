package com.sunny.numbertracker;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

public class SunnySyncService extends Service {
    public static final String ACTION_START = "com.sunny.numbertracker.SYNC_START";
    public static final String ACTION_STOP = "com.sunny.numbertracker.SYNC_STOP";
    public static final String ACTION_SYNC_RECEIVED = "com.sunny.numbertracker.SYNC_DATA_RECEIVED";

    private static final String CHANNEL_LIVE = "sunny_live_sync";
    private static final String CHANNEL_ALERT = "sunny_sync_alert";
    private static final int NOTIF_LIVE_ID = 1001;
    private static final int NOTIF_OFF_ALERT_ID = 1002;
    private static final String PREFS_NAME = "sunny_bridge_prefs";
    private static final String KEY_SYNC_ENABLED = "bg_sync_enabled";
    private static final String KEY_SYNC_TOPIC = "bg_sync_topic";
    private static final String KEY_SYNC_DEVICE_ID = "bg_sync_device_id";
    private static final String KEY_PENDING_SYNC_JSON = "bg_pending_sync_json";
    private static final long HEARTBEAT_INTERVAL_MS = 25000L;

    private volatile boolean running = false;
    private Thread workerThread;
    private Thread heartbeatThread;
    private HttpURLConnection activeConn;
    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        if (ACTION_STOP.equals(action)) {
            prefs.edit().putBoolean(KEY_SYNC_ENABLED, false).apply();
            stopWorker();
            showSyncOffNotification("सिंक ऑफ है अभी इस ऐप्लिकेशन का");
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        String topic = intent != null && intent.hasExtra("topic")
                ? intent.getStringExtra("topic")
                : prefs.getString(KEY_SYNC_TOPIC, "");
        if (topic == null || topic.trim().isEmpty()) {
            showSyncOffNotification("सिंक कोड सेट नहीं है — सिंक ऑफ है");
            stopSelf();
            return START_NOT_STICKY;
        }

        String deviceId = intent != null && intent.hasExtra("deviceId")
                ? intent.getStringExtra("deviceId")
                : prefs.getString(KEY_SYNC_DEVICE_ID, "");
        if (deviceId == null || deviceId.trim().isEmpty()) {
            deviceId = "svc-" + UUID.randomUUID().toString().substring(0, 8);
        }

        prefs.edit()
                .putBoolean(KEY_SYNC_ENABLED, true)
                .putString(KEY_SYNC_TOPIC, topic.trim())
                .putString(KEY_SYNC_DEVICE_ID, deviceId.trim())
                .apply();
        cancelOffAlert();

        Notification fgNotif = buildLiveNotification("🟢 लाइव सिंक चालू है (24 घंटे सक्रिय)");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_LIVE_ID, fgNotif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_LIVE_ID, fgNotif);
        }

        startWorker(topic.trim(), deviceId.trim());
        return START_STICKY;
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SunnyTracker::SyncWakeLock");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire();
            }
        } catch (Exception ignored) {}
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {}
    }

    private void startWorker(final String topic, final String deviceId) {
        stopWorker();
        running = true;
        acquireWakeLock();

        workerThread = new Thread(() -> {
            while (running) {
                try {
                    URL url = new URL("https://ntfy.sh/" + topic + "/sse");
                    activeConn = (HttpURLConnection) url.openConnection();
                    activeConn.setConnectTimeout(15000);
                    activeConn.setReadTimeout(0);
                    activeConn.setRequestMethod("GET");

                    int code = activeConn.getResponseCode();
                    if (code == 200) {
                        updateLiveNotification("🟢 लाइव सिंक जुड़ा है (" + topic.replace("sunny_jnt_", "") + ")");
                        BufferedReader reader = new BufferedReader(new InputStreamReader(activeConn.getInputStream()));
                        String line;
                        while (running && (line = reader.readLine()) != null) {
                            if (line.startsWith("data:")) {
                                String rawJson = line.substring(5).trim();
                                handleIncomingSseData(rawJson);
                            }
                        }
                        reader.close();
                    }
                } catch (Exception e) {
                    if (running) {
                        updateLiveNotification("🟡 नेटवर्क इंतज़ार... (ऑटो रीकनेक्ट)");
                    }
                } finally {
                    if (activeConn != null) {
                        try { activeConn.disconnect(); } catch (Exception ignored) {}
                    }
                }
                if (running) {
                    try { Thread.sleep(5000); } catch (InterruptedException ignored) { break; }
                }
            }
        });
        workerThread.start();

        // 24/7 native heartbeat so backgrounded / screen-off phones stay Connected: 4
        heartbeatThread = new Thread(() -> {
            while (running) {
                sendHeartbeatPing(topic, deviceId);
                try {
                    Thread.sleep(HEARTBEAT_INTERVAL_MS);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
        });
        heartbeatThread.start();
    }

    private void sendHeartbeatPing(String topic, String deviceId) {
        HttpURLConnection conn = null;
        try {
            JSONObject ping = new JSONObject();
            ping.put("type", "SUNNY_PING_V1");
            ping.put("senderId", deviceId);
            ping.put("sentAt", System.currentTimeMillis());
            byte[] bytes = ping.toString().getBytes(StandardCharsets.UTF_8);

            URL url = new URL("https://ntfy.sh/" + topic);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }
            conn.getResponseCode();
        } catch (Exception ignored) {
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
    }

    private void handleIncomingSseData(String rawJson) {
        try {
            JSONObject wrapper = new JSONObject(rawJson);
            String msg = wrapper.optString("message", "");
            if (msg.isEmpty()) return;
            boolean isSyncData = msg.contains("SUNNY_SYNC_V1");
            boolean isPing = msg.contains("SUNNY_PING_V1");
            if (!isSyncData && !isPing) return;

            if (isSyncData) {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                prefs.edit().putString(KEY_PENDING_SYNC_JSON, msg).apply();
            }

            Intent b = new Intent(ACTION_SYNC_RECEIVED);
            b.setPackage(getPackageName());
            b.putExtra("payload", msg);
            sendBroadcast(b);
        } catch (Exception ignored) {}
    }

    private void stopWorker() {
        running = false;
        if (activeConn != null) {
            try { activeConn.disconnect(); } catch (Exception ignored) {}
        }
        if (workerThread != null) {
            workerThread.interrupt();
            workerThread = null;
        }
        if (heartbeatThread != null) {
            heartbeatThread.interrupt();
            heartbeatThread = null;
        }
        releaseWakeLock();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (prefs.getBoolean(KEY_SYNC_ENABLED, false)) {
            Intent restartIntent = new Intent(getApplicationContext(), SunnySyncService.class);
            restartIntent.setAction(ACTION_START);
            restartIntent.putExtra("topic", prefs.getString(KEY_SYNC_TOPIC, ""));
            restartIntent.putExtra("deviceId", prefs.getString(KEY_SYNC_DEVICE_ID, ""));
            PendingIntent pi = PendingIntent.getService(
                    getApplicationContext(),
                    2,
                    restartIntent,
                    PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE
            );
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 1000, pi);
            }
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (!prefs.getBoolean(KEY_SYNC_ENABLED, false)) {
            showSyncOffNotification("सिंक ऑफ है अभी इस ऐप्लिकेशन का");
        }
        stopWorker();
        super.onDestroy();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm == null) return;
            NotificationChannel liveCh = new NotificationChannel(CHANNEL_LIVE, "Sunny Live Sync", NotificationManager.IMPORTANCE_LOW);
            liveCh.setDescription("24x7 बैकग्राउंड सिंक स्टेटस");
            nm.createNotificationChannel(liveCh);

            NotificationChannel alertCh = new NotificationChannel(CHANNEL_ALERT, "Sync Off Alert", NotificationManager.IMPORTANCE_HIGH);
            alertCh.setDescription("सिंक बंद होने पर तुरंत अलर्ट");
            nm.createNotificationChannel(alertCh);
        }
    }

    private Notification buildLiveNotification(String text) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_LIVE)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Sunny Number Tracker")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    private void updateLiveNotification(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_LIVE_ID, buildLiveNotification(text));
    }

    private void showSyncOffNotification(String msg) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 1, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("⚠️ Sunny Sync बंद है")
                .setContentText(msg)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pi)
                .build();
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_OFF_ALERT_ID, n);
    }

    private void cancelOffAlert() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIF_OFF_ALERT_ID);
    }
}
