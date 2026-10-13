package dev.dumbtalk.android;

import static org.unifiedpush.android.connector.ConstantsKt.INSTANCE_DEFAULT;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.widget.Toast;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;
import org.unifiedpush.android.connector.UnifiedPush;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PublicKeySet;

final class PushClient {
    private static final String PREFS = "push";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private PushClient() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isEnabled(Context context) { return prefs(context).getBoolean("enabled", false); }
    static boolean hasEndpoint(Context context) { return prefs(context).getString("endpoint", null) != null; }
    static String status(Context context) { return prefs(context).getString("status", "Not configured"); }
    static void setStatus(Context context, String value) { prefs(context).edit().putString("status", value).apply(); }

    private static String deviceId(Context context) {
        String existing = prefs(context).getString("deviceId", null);
        if (existing != null) return existing;
        String created = UUID.randomUUID().toString();
        prefs(context).edit().putString("deviceId", created).apply();
        return created;
    }

    static void enable(Activity activity) {
        ConnectionStore connection = new ConnectionStore(activity);
        if (connection.origin() == null) return;
        prefs(activity).edit().putBoolean("enabled", true).apply();
        setStatus(activity, "Finding push distributor…");
        IO.execute(() -> {
            try {
                JSONObject vapid = request(connection, "GET", "/api/push/vapid", null);
                String publicKey = vapid.getString("publicKey");
                activity.runOnUiThread(() -> chooseDistributor(activity, publicKey));
            } catch (Exception error) {
                setStatus(activity, "Could not reach DumbTalk push setup");
                activity.runOnUiThread(() -> Toast.makeText(activity, status(activity), Toast.LENGTH_LONG).show());
            }
        });
    }

    private static void chooseDistributor(Activity activity, String publicKey) {
        if (activity.isFinishing() || !isEnabled(activity)) return;
        List<String> distributors = UnifiedPush.getDistributors(activity);
        String saved = UnifiedPush.getAckDistributor(activity);
        if (saved == null) saved = UnifiedPush.getSavedDistributor(activity);
        if (saved != null && distributors.contains(saved)) {
            register(activity, publicKey);
            return;
        }
        if (distributors.isEmpty()) {
            setStatus(activity, "Install a UnifiedPush distributor first, such as ntfy or Sunup");
            Toast.makeText(activity, status(activity), Toast.LENGTH_LONG).show();
            return;
        }
        if (distributors.size() == 1) {
            UnifiedPush.saveDistributor(activity, distributors.get(0));
            register(activity, publicKey);
            return;
        }
        String[] names = distributors.toArray(new String[0]);
        new AlertDialog.Builder(activity)
                .setTitle("Choose push distributor")
                .setItems(names, (dialog, selected) -> {
                    UnifiedPush.saveDistributor(activity, names[selected]);
                    register(activity, publicKey);
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private static void register(Activity activity, String publicKey) {
        setStatus(activity, "Registering with distributor…");
        UnifiedPush.register(activity, INSTANCE_DEFAULT, "DumbTalk messages", publicKey);
    }

    static void saveEndpoint(Context context, PushEndpoint endpoint) {
        if (!isEnabled(context)) return;
        PublicKeySet keys = endpoint.getPubKeySet();
        if (keys == null) {
            setStatus(context, "Distributor did not provide Web Push encryption keys");
            return;
        }
        prefs(context).edit()
                .putString("endpoint", endpoint.getUrl())
                .putString("p256dh", keys.getPubKey())
                .putString("auth", keys.getAuth())
                .apply();
        syncSaved(context);
    }

    static void syncSaved(Context context) {
        if (!isEnabled(context)) return;
        SharedPreferences saved = prefs(context);
        String endpoint = saved.getString("endpoint", null);
        if (endpoint == null) return;
        setStatus(context, "Connecting push to DumbTalk…");
        IO.execute(() -> {
            try {
                JSONObject subscription = new JSONObject()
                        .put("deviceId", deviceId(context))
                        .put("endpoint", endpoint)
                        .put("p256dh", saved.getString("p256dh", ""))
                        .put("auth", saved.getString("auth", ""));
                request(new ConnectionStore(context), "POST", "/api/push/subscription", subscription);
                setStatus(context, "Notifications enabled");
            } catch (Exception error) {
                setStatus(context, "Push connection failed; retry from connection settings");
            }
        });
    }

    static void sendTest(Activity activity) {
        if (!isEnabled(activity) || prefs(activity).getString("endpoint", null) == null) {
            Toast.makeText(activity, "Enable notifications and wait for registration first", Toast.LENGTH_LONG).show();
            return;
        }
        IO.execute(() -> {
            String outcome;
            try {
                JSONObject result = request(new ConnectionStore(activity), "POST", "/api/push/test", new JSONObject().put("deviceId", deviceId(activity)));
                outcome = result.optInt("sent") > 0 ? "Test push sent" : "Push server did not accept the test";
            } catch (Exception error) { outcome = "Test push failed"; }
            String message = outcome;
            activity.runOnUiThread(() -> Toast.makeText(activity, message, Toast.LENGTH_LONG).show());
        });
    }

    static void disable(Context context) {
        prefs(context).edit().putBoolean("enabled", false).apply();
        UnifiedPush.unregister(context, INSTANCE_DEFAULT);
        clearEndpoint(context);
        setStatus(context, "Notifications disabled");
    }

    static void clearEndpoint(Context context) {
        SharedPreferences saved = prefs(context);
        if (saved.getString("endpoint", null) == null) return;
        String id = deviceId(context);
        ConnectionStore connection = new ConnectionStore(context);
        try {
            String origin = connection.origin();
            String token = connection.token();
            IO.execute(() -> {
                try { request(origin, token, "DELETE", "/api/push/subscription", new JSONObject().put("deviceId", id)); }
                catch (Exception ignored) {}
            });
        } catch (Exception ignored) {}
        saved.edit().remove("endpoint").remove("p256dh").remove("auth").apply();
    }

    private static JSONObject request(ConnectionStore connection, String method, String path, JSONObject payload) throws Exception {
        return request(connection.origin(), connection.token(), method, path, payload);
    }

    private static JSONObject request(String origin, String token, String method, String path, JSONObject payload) throws Exception {
        if (origin == null || token == null) throw new IllegalStateException("No DumbTalk connection");
        HttpURLConnection request = (HttpURLConnection) new URL(origin + path).openConnection();
        request.setConnectTimeout(8000);
        request.setReadTimeout(8000);
        request.setRequestMethod(method);
        request.setRequestProperty("Authorization", "Bearer " + token);
        request.setRequestProperty("Origin", origin);
        try {
            if (payload != null) {
                request.setDoOutput(true);
                request.setRequestProperty("Content-Type", "application/json");
                byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
                request.getOutputStream().write(body);
            }
            int status = request.getResponseCode();
            if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
            try (InputStream input = request.getInputStream()) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int length;
                while ((length = input.read(buffer)) != -1) output.write(buffer, 0, length);
                return new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally { request.disconnect(); }
    }
}
