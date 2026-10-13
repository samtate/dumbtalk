package dev.dumbtalk.android;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import java.nio.charset.StandardCharsets;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
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
    private static final Object LOCK = new Object();

    @Override public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        PushClient.saveEndpoint(this, endpoint);
    }

    @Override public void onMessage(PushMessage message, String instance) {
        if (!message.getDecrypted() || !PushClient.isEnabled(this)) {
            Log.w("DumbTalkPush", "Push rejected: undecrypted or disabled");
            return;
        }
        try {
            JSONObject payload = new JSONObject(new String(message.getContent(), StandardCharsets.UTF_8));
            String event = payload.optString("event");
            if (!"new-message".equals(event) && !"test".equals(event)) return;
            boolean test = "test".equals(event);
            String chat = payload.optString("conversationId", "test");
            // Compatibility with older Signal backend payloads.
            if (chat.startsWith("group:") || chat.startsWith("direct:")) chat = "signal:" + chat;
            if (!test && MainActivity.suppressPush(chat)) return;
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
            synchronized (LOCK) { post(payload, chat, test); }
        } catch (Exception error) {
            Log.e("DumbTalkPush", "Could not display notification", error);
        }
    }

    private Notification active(String chat) {
        for (StatusBarNotification entry : getSystemService(NotificationManager.class).getActiveNotifications()) {
            if (chat.equals(entry.getTag())) return entry.getNotification();
        }
        return null;
    }

    private void post(JSONObject payload, String chat, boolean test) throws Exception {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_DEFAULT));
        if (!manager.areNotificationsEnabled()) {
            Log.w("DumbTalkPush", "Notifications blocked by Android");
            return;
        }
        String title = test ? "DumbTalk" : payload.optString("title", "New message");
        String body = test ? "Test notification" : payload.optString("body", "New message");
        boolean group = payload.optBoolean("isGroup", chat.startsWith("signal:group:"));
        String sender = payload.optString("sender", title);
        long timestamp = payload.optLong("timestamp", System.currentTimeMillis());
        String messageId = payload.optString("messageId", timestamp + ":" + body);
        Notification previous = active(chat);
        Notification.MessagingStyle oldStyle = previous == null ? null
                : Notification.MessagingStyle.extractMessagingStyleFromNotification(previous);
        List<Notification.MessagingStyle.Message> messages = new ArrayList<>();
        if (oldStyle != null) messages.addAll(oldStyle.getMessages());
        for (Notification.MessagingStyle.Message old : messages) {
            if (messageId.equals(old.getExtras().getString("messageId"))) return;
        }
        Icon avatar = previous == null ? null : previous.getLargeIcon();
        if (avatar == null) avatar = Icon.createWithBitmap(initials(title));
        Person.Builder person = new Person.Builder().setName(sender)
                .setKey(payload.optString("senderId", sender));
        if (!group) person.setIcon(avatar);
        Notification.MessagingStyle.Message incoming =
                new Notification.MessagingStyle.Message(body, timestamp, person.build());
        incoming.getExtras().putString("messageId", messageId);
        messages.add(incoming);
        messages.sort(Comparator.comparingLong(Notification.MessagingStyle.Message::getTimestamp));
        if (messages.size() > 25) messages = new ArrayList<>(messages.subList(messages.size() - 25, messages.size()));
        Notification.MessagingStyle style = new Notification.MessagingStyle(new Person.Builder().setName("You").build())
                .setGroupConversation(group);
        if (group) style.setConversationTitle(title);
        for (Notification.MessagingStyle.Message entry : messages) style.addMessage(entry);
        Intent open = new Intent(this, MainActivity.class)
                .setData(new Uri.Builder().scheme("dumbtalk").authority("chat").appendPath(chat).build())
                .putExtra("conversationId", test ? "" : chat)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent action = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Bundle extras = new Bundle();
        extras.putString("dumbtalkRevision", messageId);
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(title).setContentText(body)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setStyle(style).setLargeIcon(avatar)
                .setWhen(messages.get(messages.size() - 1).getTimestamp())
                .setContentIntent(action).setAutoCancel(true)
                .addExtras(extras).build();
        // Post before starting optional network work. Android owns the history even if we exit.
        manager.notify(chat, 1, notification);
        Log.i("DumbTalkPush", "Posted message notification");
        String path = payload.optString("avatarPath", "");
        if (path.startsWith("/api/")) IO.execute(() -> {
            Bitmap bitmap = avatarBitmap(path);
            if (bitmap == null) return;
            synchronized (LOCK) {
                Notification current = active(chat);
                if (current == null || !messageId.equals(current.extras.getString("dumbtalkRevision"))) return;
                Icon icon = Icon.createWithBitmap(bitmap);
                Notification.MessagingStyle currentStyle = Notification.MessagingStyle.extractMessagingStyleFromNotification(current);
                if (!group && currentStyle != null) {
                    Notification.MessagingStyle updated = new Notification.MessagingStyle(currentStyle.getUser()).setGroupConversation(false);
                    for (Notification.MessagingStyle.Message entry : currentStyle.getMessages()) {
                        Person author = entry.getSenderPerson();
                        Person withIcon = new Person.Builder().setName(author.getName()).setKey(author.getKey()).setIcon(icon).build();
                        Notification.MessagingStyle.Message replacement = new Notification.MessagingStyle.Message(entry.getText(), entry.getTimestamp(), withIcon);
                        replacement.getExtras().putAll(entry.getExtras());
                        updated.addMessage(replacement);
                    }
                    currentStyle = updated;
                }
                manager.notify(chat, 1, Notification.Builder.recoverBuilder(this, current)
                        .setStyle(currentStyle).setLargeIcon(icon).setOnlyAlertOnce(true).build());
            }
        });
    }

    private Bitmap initials(String title) {
        Bitmap bitmap = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(Color.rgb(36, 90, 70)); canvas.drawCircle(64, 64, 64, paint);
        paint.setColor(Color.WHITE); paint.setTextSize(56); paint.setTextAlign(Paint.Align.CENTER);
        String letter = title.isEmpty() ? "?" : title.substring(0, title.offsetByCodePoints(0, 1)).toUpperCase();
        canvas.drawText(letter, 64, 64 - (paint.ascent() + paint.descent()) / 2, paint);
        return bitmap;
    }

    private Bitmap avatarBitmap(String path) {
        HttpURLConnection request = null;
        try {
            ConnectionStore connection = new ConnectionStore(this);
            request = (HttpURLConnection) new URL(connection.origin() + path).openConnection();
            request.setInstanceFollowRedirects(false);
            request.setConnectTimeout(3000); request.setReadTimeout(3000);
            request.setRequestProperty("Authorization", "Bearer " + connection.token());
            if (request.getResponseCode() != 200) return null;
            try (java.io.InputStream input = request.getInputStream()) {
                java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int length;
                while ((length = input.read(buffer)) != -1) {
                    output.write(buffer, 0, length);
                    if (output.size() > 2 * 1024 * 1024) return null;
                }
                byte[] bytes = output.toByteArray();
                if (bytes.length > 2 * 1024 * 1024) return null;
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
                options.inSampleSize = 1;
                while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 256) options.inSampleSize *= 2;
                options.inJustDecodeBounds = false;
                return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            }
        } catch (Exception ignored) { return null; }
        finally { if (request != null) request.disconnect(); }
    }

    @Override public void onUnregistered(String instance) { PushClient.clearEndpoint(this); }
    @Override public void onRegistrationFailed(FailedReason reason, String instance) {
        PushClient.setStatus(this, "Registration failed: " + reason.name());
    }
}
