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

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

public class SunnySyncService extends Service {
    public static final String ACTION_START = "com.sunny.numbertracker.SYNC_START";
    public static final String ACTION_STOP = "com.sunny.numbertracker.SYNC_STOP";
    public static final String ACTION_UPDATE_STATS = "com.sunny.numbertracker.UPDATE_STATS";
    public static final String ACTION_SYNC_RECEIVED = "com.sunny.numbertracker.SYNC_DATA_RECEIVED";

    private static final String MQTT_HOST = "broker.emqx.io";
    private static final int MQTT_PORT = 1883;
    private static final String CHANNEL_LIVE = "sunny_live_sync";
    private static final String CHANNEL_ALERT = "sunny_sync_alert";
    private static final int NOTIF_LIVE_ID = 1001;
    private static final int NOTIF_OFF_ALERT_ID = 1002;
    private static final String PREFS_NAME = "sunny_bridge_prefs";
    private static final String KEY_SYNC_ENABLED = "bg_sync_enabled";
    private static final String KEY_SYNC_TOPIC = "bg_sync_topic";
    private static final String KEY_SYNC_DEVICE_ID = "bg_sync_device_id";
    private static final String KEY_PENDING_SYNC_JSON = "bg_pending_sync_json";
    private static final long HEARTBEAT_INTERVAL_MS = 40000L;

    private volatile boolean running = false;
    private Thread workerThread;
    private Socket activeSocket;
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

        if (ACTION_UPDATE_STATS.equals(action)) {
            String summary = intent != null ? intent.getStringExtra("summary") : null;
            if (summary != null && !summary.trim().isEmpty()) {
                prefs.edit().putString("live_stats_summary", summary.trim()).apply();
                updateLiveNotification(summary.trim());
                Intent b = new Intent("com.sunny.numbertracker.LIVE_STATS");
                b.putExtra("summary", summary.trim());
                sendBroadcast(b);
            }
            return START_STICKY;
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

        // Pure-Java MQTT 3.1.1 persistent connection with retained presence + sync listener (0 rate limits)
        workerThread = new Thread(() -> {
            long lastPingAt = 0L;
            while (running) {
                Socket sock = null;
                try {
                    sock = new Socket();
                    activeSocket = sock;
                    sock.connect(new InetSocketAddress(MQTT_HOST, MQTT_PORT), 12000);
                    sock.setSoTimeout(50000);
                    OutputStream out = sock.getOutputStream();
                    InputStream in = sock.getInputStream();

                    // 1. MQTT CONNECT
                    String clientId = "sunny_svc_" + deviceId + "_" + (System.currentTimeMillis() % 10000);
                    out.write(buildMqttConnectPacket(clientId));
                    out.flush();
                    int connAck = readMqttPacketType(in);
                    if (connAck != 2) throw new Exception("CONNACK=" + connAck);

                    // 2. MQTT SUBSCRIBE to topic/sync, topic/dev/+, and topic/stats
                    out.write(buildMqttSubscribePacket(1, new String[]{topic + "/sync", topic + "/dev/+", topic + "/stats"}));
                    out.flush();

                    updateLiveNotification("🟢 लाइव सिंक जुड़ा है (" + topic.replace("sunny_jnt_", "") + ")");

                    // 3. Publish retained online heartbeat immediately + every 40s
                    publishPresence(out, topic, deviceId);
                    lastPingAt = System.currentTimeMillis();

                    while (running) {
                        long now = System.currentTimeMillis();
                        if (now - lastPingAt >= HEARTBEAT_INTERVAL_MS) {
                            publishPresence(out, topic, deviceId);
                            lastPingAt = now;
                        }
                        if (in.available() > 0) {
                            handleMqttIncoming(in);
                        } else {
                            Thread.sleep(400);
                        }
                    }
                } catch (Exception e) {
                    if (running) {
                        updateLiveNotification("🟡 नेटवर्क इंतज़ार... (ऑटो रीकनेक्ट)");
                    }
                } finally {
                    if (sock != null) {
                        try { sock.close(); } catch (Exception ignored) {}
                    }
                    activeSocket = null;
                }
                if (running) {
                    try { Thread.sleep(4000); } catch (InterruptedException ignored) { break; }
                }
            }
        });
        workerThread.start();
    }

    private void publishPresence(OutputStream out, String topic, String deviceId) throws Exception {
        JSONObject ping = new JSONObject();
        ping.put("type", "SUNNY_PING_V1");
        ping.put("senderId", deviceId);
        ping.put("sentAt", System.currentTimeMillis());
        out.write(buildMqttPublishPacket(topic + "/dev/" + deviceId, ping.toString(), true));
        out.flush();
    }

    private void handleMqttIncoming(InputStream in) throws Exception {
        int b1 = in.read();
        if (b1 < 0) throw new Exception("EOF");
        int packetType = (b1 >> 4) & 0x0F;
        int remLen = readRemainingLength(in);
        byte[] body = new byte[remLen];
        int off = 0;
        while (off < remLen) {
            int r = in.read(body, off, remLen - off);
            if (r < 0) throw new Exception("EOF");
            off += r;
        }
        if (packetType == 3 && body.length >= 2) { // PUBLISH
            int topicLen = ((body[0] & 0xFF) << 8) | (body[1] & 0xFF);
            int pos = 2 + topicLen;
            if ((b1 & 0x06) != 0) pos += 2; // QoS > 0 packet id
            if (pos <= body.length) {
                String msg = new String(body, pos, body.length - pos, StandardCharsets.UTF_8);
                if (msg.contains("\"summary\"")) {
                    try {
                        String sum = new JSONObject(msg).optString("summary", "").trim();
                        if (!sum.isEmpty()) {
                            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                                    .edit()
                                    .putString("live_stats_summary", sum)
                                    .apply();
                            updateLiveNotification(sum);
                            Intent kb = new Intent("com.sunny.numbertracker.LIVE_STATS");
                            kb.putExtra("summary", sum);
                            sendBroadcast(kb);
                        }
                    } catch (Exception ignored) {}
                }
                if (msg.contains("SUNNY_SYNC_V1")) {
                    getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                            .edit()
                            .putString(KEY_PENDING_SYNC_JSON, msg)
                            .apply();
                }
                if (msg.contains("SUNNY_SYNC_V1") || msg.contains("SUNNY_PING_V1")) {
                    Intent b = new Intent(ACTION_SYNC_RECEIVED);
                    b.setPackage(getPackageName());
                    b.putExtra("payload", msg);
                    sendBroadcast(b);
                }
            }
        }
    }

    private int readMqttPacketType(InputStream in) throws Exception {
        int b1 = in.read();
        if (b1 < 0) return -1;
        int remLen = readRemainingLength(in);
        for (int i = 0; i < remLen; i++) {
            if (in.read() < 0) break;
        }
        return (b1 >> 4) & 0x0F;
    }

    private int readRemainingLength(InputStream in) throws Exception {
        int multiplier = 1;
        int value = 0;
        int encodedByte;
        do {
            encodedByte = in.read();
            if (encodedByte < 0) throw new Exception("EOF");
            value += (encodedByte & 127) * multiplier;
            multiplier *= 128;
        } while ((encodedByte & 128) != 0);
        return value;
    }

    private byte[] buildMqttConnectPacket(String clientId) throws Exception {
        ByteArrayOutputStream varAndPayload = new ByteArrayOutputStream();
        writeMqttString(varAndPayload, "MQTT");
        varAndPayload.write(4); // Protocol level 3.1.1
        varAndPayload.write(0x02); // Clean session
        varAndPayload.write(0);
        varAndPayload.write(120); // Keepalive 120s
        writeMqttString(varAndPayload, clientId);
        return wrapMqttPacket(0x10, varAndPayload.toByteArray());
    }

    private byte[] buildMqttSubscribePacket(int packetId, String[] topics) throws Exception {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        body.write((packetId >> 8) & 0xFF);
        body.write(packetId & 0xFF);
        for (String t : topics) {
            writeMqttString(body, t);
            body.write(0); // QoS 0
        }
        return wrapMqttPacket(0x82, body.toByteArray());
    }

    private byte[] buildMqttPublishPacket(String topic, String payload, boolean retain) throws Exception {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        writeMqttString(body, topic);
        body.write(payload.getBytes(StandardCharsets.UTF_8));
        return wrapMqttPacket(retain ? 0x31 : 0x30, body.toByteArray());
    }

    private void writeMqttString(ByteArrayOutputStream out, String s) throws Exception {
        byte[] bytes = s.getBytes(StandardCharsets.UTF_8);
        out.write((bytes.length >> 8) & 0xFF);
        out.write(bytes.length & 0xFF);
        out.write(bytes);
    }

    private byte[] wrapMqttPacket(int headerByte, byte[] body) throws Exception {
        ByteArrayOutputStream pkt = new ByteArrayOutputStream();
        pkt.write(headerByte);
        int x = body.length;
        do {
            int encodedByte = x % 128;
            x /= 128;
            if (x > 0) encodedByte |= 128;
            pkt.write(encodedByte);
        } while (x > 0);
        pkt.write(body);
        return pkt.toByteArray();
    }

    private void stopWorker() {
        running = false;
        if (activeSocket != null) {
            try { activeSocket.close(); } catch (Exception ignored) {}
            activeSocket = null;
        }
        if (workerThread != null) {
            workerThread.interrupt();
            workerThread = null;
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
        openIntent.putExtra("from_copy_trigger", true);
        PendingIntent pi = PendingIntent.getActivity(this, 0, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_LIVE)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Sunny Number Tracker")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pi)
                .addAction(R.mipmap.ic_launcher, "📋 Paste", pi)
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
