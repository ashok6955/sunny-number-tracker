package com.sunny.numbertracker;

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

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

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
    private static final String KEY_PENDING_SYNC_JSON = "bg_pending_sync_json";

    private volatile boolean running = false;
    private Thread workerThread;
    private HttpURLConnection activeConn;

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

        prefs.edit().putBoolean(KEY_SYNC_ENABLED, true).putString(KEY_SYNC_TOPIC, topic.trim()).apply();
        cancelOffAlert();
        Notification fgNotif = buildLiveNotification("🟢 लाइव सिंक चालू है (24 घंटे सक्रिय)");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_LIVE_ID, fgNotif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_LIVE_ID, fgNotif);
        }

        startWorker(topic.trim());
        return START_STICKY;
    }

    private void startWorker(final String topic) {
        stopWorker();
        running = true;
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
    }

    private void handleIncomingSseData(String rawJson) {
        try {
            JSONObject wrapper = new JSONObject(rawJson);
            String msg = wrapper.optString("message", "");
            if (msg.isEmpty() || !msg.contains("SUNNY_SYNC_V1")) return;
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            prefs.edit().putString(KEY_PENDING_SYNC_JSON, msg).apply();

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
