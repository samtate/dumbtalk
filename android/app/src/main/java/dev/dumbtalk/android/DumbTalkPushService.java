package dev.dumbtalk.android;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import java.nio.charset.StandardCharsets;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

public final class DumbTalkPushService extends PushService {
    private static final String CHANNEL = "dumbtalk-messages";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    @Override public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        PushClient.saveEndpoint(this, endpoint);
    }

    @Override public void onMessage(PushMessage message, String instance) {
        if (!message.getDecrypted() || !PushClient.isEnabled(this)) return;
        boolean test;
        String conversationId = null;
        String title = "New message";
        String body = "New message";
        String avatarPath = null;
        try {
            JSONObject payload = new JSONObject(new String(message.getContent(), StandardCharsets.UTF_8));
            String event = payload.optString("event");
            if (!"new-message".equals(event) && !"test".equals(event)) return;
            test = "test".equals(event);
            conversationId = payload.optString("conversationId", null);
            title = payload.optString("title", title);
            body = payload.optString("body", body);
            avatarPath = payload.optString("avatarPath", null);
        } catch (Exception invalid) { return; }
        if (!test && MainActivity.suppressPush(conversationId)) return;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;

        final String notificationTitle = test ? "DumbTalk" : title;
        final String notificationBody = test ? "Test notification" : body;
        final String notificationAvatar = avatarPath;
        IO.execute(() -> showNotification(notificationTitle, notificationBody, notificationAvatar));
    }

    private void showNotification(String title, String body, String avatarPath) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_DEFAULT));
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent action = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(title)
                .setContentText(body)
                .setContentIntent(action)
                .setAutoCancel(true);
        Bitmap avatar = avatarBitmap(avatarPath);
        if (avatar != null) builder.setLargeIcon(avatar);
        manager.notify(1, builder.build());
    }

    private Bitmap avatarBitmap(String path) {
        if (path == null || path.isEmpty()) return null;
        HttpURLConnection request = null;
        try {
            ConnectionStore connection = new ConnectionStore(this);
            request = (HttpURLConnection) new URL(connection.origin() + path).openConnection();
            request.setConnectTimeout(5000);
            request.setReadTimeout(5000);
            request.setRequestProperty("Authorization", "Bearer " + connection.token());
            if (request.getResponseCode() != 200) return null;
            return BitmapFactory.decodeStream(request.getInputStream());
        } catch (Exception ignored) { return null; }
        finally { if (request != null) request.disconnect(); }
    }

    @Override public void onUnregistered(String instance) {
        PushClient.clearEndpoint(this);
    }

    @Override public void onRegistrationFailed(FailedReason reason, String instance) {
        PushClient.setStatus(this, "Registration failed: " + reason.name());
    }
}
