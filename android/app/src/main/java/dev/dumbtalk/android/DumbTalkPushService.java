package dev.dumbtalk.android;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

public final class DumbTalkPushService extends PushService {
    private static final String CHANNEL = "dumbtalk-messages";

    @Override public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        PushClient.saveEndpoint(this, endpoint);
    }

    @Override public void onMessage(PushMessage message, String instance) {
        if (!message.getDecrypted() || !PushClient.isEnabled(this)) return;
        boolean test;
        try {
            JSONObject payload = new JSONObject(new String(message.getContent(), StandardCharsets.UTF_8));
            String event = payload.optString("event");
            if (!"new-message".equals(event) && !"test".equals(event)) return;
            test = "test".equals(event);
        } catch (Exception invalid) { return; }
        if (!test && MainActivity.isVisible()) return;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;

        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_DEFAULT));
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent action = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notice = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle("DumbTalk")
                .setContentText(test ? "Test notification" : "New message")
                .setContentIntent(action)
                .setAutoCancel(true)
                .build();
        manager.notify(1, notice);
    }

    @Override public void onUnregistered(String instance) {
        PushClient.clearEndpoint(this);
    }

    @Override public void onRegistrationFailed(FailedReason reason, String instance) {
        PushClient.setStatus(this, "Registration failed: " + reason.name());
    }
}
