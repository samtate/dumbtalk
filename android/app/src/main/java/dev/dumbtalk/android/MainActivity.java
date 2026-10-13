package dev.dumbtalk.android;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int FILE_REQUEST = 41;
    private static final int AUDIO_REQUEST = 42;
    private static final int NOTIFICATION_REQUEST = 43;
    private static volatile boolean visible;
    private static volatile String pushScreen;
    private static volatile String pushConversation;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private ConnectionStore connection;
    private WebView webView;
    private String origin;
    private String token;
    private android.webkit.ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private PermissionRequest audioRequest;
    private boolean pageFailed;
    private boolean backOpenedSettings;
    private volatile String pendingPushChat = "";

    static boolean isVisible() { return visible; }
    static boolean suppressPush(String conversationId) {
        if (!visible) return false;
        if ("conversations".equals(pushScreen)) return true;
        return "chat".equals(pushScreen) && conversationId != null && conversationId.equals(pushConversation);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        pendingPushChat = intent.getStringExtra("conversationId");
        if (webView != null) webView.evaluateJavascript("window.dispatchEvent(new Event('dumbtalk-open-chat'))", null);
    }

    private final class PushContextBridge {
        @JavascriptInterface public String pendingChat() { return pendingPushChat == null ? "" : pendingPushChat; }
        @JavascriptInterface public void openedChat(String id) {
            if (id.equals(pendingPushChat)) pendingPushChat = "";
        }

        @JavascriptInterface public void set(String screen, String conversationId) {
            pushScreen = screen;
            pushConversation = conversationId;
            if (visible) runOnUiThread(() -> {
                android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
                if ("conversations".equals(screen) && (pendingPushChat == null || pendingPushChat.isEmpty())) manager.cancelAll();
                else if ("chat".equals(screen)) manager.cancel(conversationId, 1);
            });
        }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        pendingPushChat = getIntent().getStringExtra("conversationId");
        getWindow().setStatusBarColor(Color.rgb(5, 10, 8));
        getWindow().setNavigationBarColor(Color.rgb(5, 10, 8));
        connection = new ConnectionStore(this);
        try {
            origin = connection.origin();
            token = connection.token();
        } catch (Exception error) {
            connection.clear();
            origin = null;
            token = null;
        }
        if (origin == null || token == null) showSetup(null);
        else {
            openConversationUi();
            if (PushClient.isEnabled(this)) enableNotifications();
        }
    }

    private LinearLayout panel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(20), dp(28), dp(20), dp(20));
        panel.setBackgroundColor(Color.rgb(11, 23, 19));
        return panel;
    }

    private TextView text(String value, int size) {
        TextView label = new TextView(this);
        label.setText(value);
        label.setTextColor(Color.WHITE);
        label.setTextSize(size);
        label.setPadding(0, 0, 0, dp(14));
        return label;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void showSetup(String error) {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (audioRequest != null) { audioRequest.deny(); audioRequest = null; }
        LinearLayout panel = panel();
        panel.addView(text("DumbTalk", 25));
        panel.addView(text("Paste your complete widget URL, including # and its access key. The phone connects directly to your DumbTalk server.", 14));
        EditText url = new EditText(this);
        url.setSingleLine(true);
        url.setTextColor(Color.WHITE);
        url.setHintTextColor(Color.LTGRAY);
        url.setHint("https://your-server.example/#access-key");
        url.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        panel.addView(url, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView status = text(error == null ? "" : error, 13);
        panel.addView(status);
        Button connect = new Button(this);
        connect.setText("Connect");
        panel.addView(connect);
        if (origin != null && token != null) {
            panel.addView(text("Notifications: " + PushClient.status(this), 14));
            Button enable = new Button(this);
            enable.setText("Enable notifications");
            enable.setOnClickListener(v -> enableNotifications());
            panel.addView(enable);
            Button test = new Button(this);
            test.setText("Send test notification");
            test.setOnClickListener(v -> PushClient.sendTest(this));
            panel.addView(test);
            Button disable = new Button(this);
            disable.setText("Disable notifications");
            disable.setOnClickListener(v -> {
                PushClient.disable(this);
                Toast.makeText(this, "Notifications disabled", Toast.LENGTH_SHORT).show();
                showSetup(null);
            });
            panel.addView(disable);
        }
        setContentView(panel);
        connect.setOnClickListener(v -> {
            final String nextOrigin;
            final String nextToken;
            try {
                URI uri = new URI(url.getText().toString().trim());
                if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                        || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                        || !(uri.getPath() == null || uri.getPath().isEmpty() || "/".equals(uri.getPath()))) {
                    throw new IllegalArgumentException("Use the HTTPS server root URL.");
                }
                nextToken = uri.getFragment();
                if (nextToken == null || !nextToken.matches("[A-Za-z0-9_-]{43,}")) {
                    throw new IllegalArgumentException("Paste the complete URL with its access key after #.");
                }
                nextOrigin = new URI("https", null, uri.getHost(), uri.getPort(), null, null, null).toString();
            } catch (Exception invalid) {
                status.setText(invalid.getMessage());
                return;
            }
            connect.setEnabled(false);
            status.setText("Checking server…");
            network.execute(() -> {
                String failure = verifyConnection(nextOrigin, nextToken);
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    if (failure != null) {
                        status.setText(failure);
                        connect.setEnabled(true);
                        return;
                    }
                    try {
                        boolean changedServer = origin != null && (!origin.equals(nextOrigin) || !token.equals(nextToken));
                        if (changedServer && PushClient.isEnabled(this)) PushClient.disable(this);
                        connection.save(nextOrigin, nextToken);
                        origin = nextOrigin;
                        token = nextToken;
                        openConversationUi();
                        if (changedServer || !PushClient.isEnabled(this)) {
                            new android.app.AlertDialog.Builder(this)
                                    .setTitle("Message notifications")
                                    .setMessage("Receive a notification when DumbTalk gets a new message? A UnifiedPush distributor must be installed on the phone.")
                                    .setPositiveButton("Enable", (dialog, which) -> enableNotifications())
                                    .setNegativeButton("Later", null)
                                    .show();
                        }
                    } catch (Exception saveError) {
                        status.setText("Could not save the connection on this phone.");
                        connect.setEnabled(true);
                    }
                });
            });
        });
    }

    private String verifyConnection(String server, String accessKey) {
        HttpURLConnection request = null;
        try {
            request = (HttpURLConnection) new URL(server + "/api/status").openConnection();
            request.setConnectTimeout(8000);
            request.setReadTimeout(8000);
            request.setRequestProperty("Authorization", "Bearer " + accessKey);
            int status = request.getResponseCode();
            if (status == 200) return null;
            if (status == 401 || status == 403 || status == 404) return "Access key rejected. Check the URL after #.";
            return "Server returned HTTP " + status + ".";
        } catch (Exception error) {
            return "Could not reach the server. Check HTTPS and the phone's connection.";
        } finally {
            if (request != null) request.disconnect();
        }
    }

    private void openConversationUi() {
        pageFailed = false;
        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(11, 23, 19));
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        // Lets the shared web UI distinguish this keypad wrapper from CloudPhone.
        webView.getSettings().setUserAgentString(
                webView.getSettings().getUserAgentString() + " DumbTalkAndroid/1");
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(true);
        webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.getSettings().setSafeBrowsingEnabled(true);
        webView.addJavascriptInterface(new PushContextBridge(), "dumbtalkAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                if (sameOrigin(request.getUrl())) return false;
                if (request.hasGesture() && "https".equalsIgnoreCase(request.getUrl().getScheme())) {
                    try {
                        Uri external = request.getUrl().buildUpon().fragment(null).build();
                        startActivity(new Intent(Intent.ACTION_VIEW, external));
                    } catch (ActivityNotFoundException unavailable) {
                        Toast.makeText(MainActivity.this, "No browser available", Toast.LENGTH_SHORT).show();
                    }
                }
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showPageFailure();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request,
                    android.webkit.WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 400) showPageFailure();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view,
                    android.webkit.ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent;
                if (params.isCaptureEnabled() && acceptsImages(params)) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Images.Media.DISPLAY_NAME, "dumbtalk-photo.jpg");
                    values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                    cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                    if (cameraUri == null) { fileCallback.onReceiveValue(null); fileCallback = null; return true; }
                    intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    intent.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                    intent.setClipData(android.content.ClipData.newRawUri("photo", cameraUri));
                    intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } else {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    String[] types = params.getAcceptTypes();
                    intent.setType(types.length == 1 && !types[0].isEmpty() ? types[0] : "*/*");
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                }
                try { startActivityForResult(intent, FILE_REQUEST); }
                catch (ActivityNotFoundException unavailable) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    discardCameraUri();
                    Toast.makeText(MainActivity.this, "No file or camera app available", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!sameOrigin(request.getOrigin()) || request.getResources().length != 1
                            || !PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(request.getResources()[0])) {
                        request.deny();
                        return;
                    }
                    audioRequest = request;
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        grantAudio();
                    } else requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_REQUEST);
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (audioRequest == request) audioRequest = null;
            }
        });
        webView.setDownloadListener((url, userAgent, disposition, mimeType, length) -> {
            Uri file = Uri.parse(url);
            if (!sameOrigin(file)) return;
            try {
                DownloadManager.Request request = new DownloadManager.Request(file);
                request.addRequestHeader("Authorization", "Bearer " + token);
                request.setMimeType(mimeType);
                request.setTitle("DumbTalk attachment");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, "dumbtalk-" + System.currentTimeMillis());
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
                Toast.makeText(this, "Downloading attachment", Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                Toast.makeText(this, "Download failed", Toast.LENGTH_SHORT).show();
            }
        });
        setContentView(webView);
        webView.loadUrl(origin + "/#" + token);
        webView.requestFocus();
    }

    private boolean acceptsImages(WebChromeClient.FileChooserParams params) {
        for (String type : params.getAcceptTypes()) if (type.startsWith("image/")) return true;
        return false;
    }

    private boolean sameOrigin(Uri url) {
        Uri trusted = Uri.parse(origin);
        return url != null && trusted.getScheme().equalsIgnoreCase(url.getScheme())
                && trusted.getHost().equalsIgnoreCase(url.getHost())
                && trusted.getPort() == url.getPort();
    }

    private void showPageFailure() {
        if (pageFailed) return;
        pageFailed = true;
        LinearLayout panel = panel();
        panel.addView(text("DumbTalk could not load", 23));
        panel.addView(text("Check the server and this phone's network connection.", 14));
        Button retry = new Button(this);
        retry.setText("Retry");
        retry.setOnClickListener(v -> openConversationUi());
        panel.addView(retry);
        Button settings = new Button(this);
        settings.setText("Change server");
        settings.setOnClickListener(v -> showSetup(null));
        panel.addView(settings);
        setContentView(panel);
        webView.destroy();
        webView = null;
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_REQUEST || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (cameraUri != null) result = new Uri[]{cameraUri};
            else if (data != null && data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                result = new Uri[count];
                for (int i = 0; i < count; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) result = new Uri[]{data.getData()};
        }
        if (resultCode != RESULT_OK) discardCameraUri();
        cameraUri = null;
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    private void discardCameraUri() {
        if (cameraUri != null) getContentResolver().delete(cameraUri, null, null);
        cameraUri = null;
    }

    private void grantAudio() {
        if (audioRequest != null) audioRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        audioRequest = null;
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(code, permissions, grants);
        if (code == NOTIFICATION_REQUEST) {
            if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) PushClient.enable(this);
            else Toast.makeText(this, "Allow notifications in Android settings to use push", Toast.LENGTH_LONG).show();
            return;
        }
        if (code != AUDIO_REQUEST || audioRequest == null) return;
        if (grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED) grantAudio();
        else { audioRequest.deny(); audioRequest = null; }
    }

    private void enableNotifications() {
        if (PushClient.isEnabled(this) && PushClient.hasEndpoint(this)) {
            PushClient.syncSaved(this);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
            return;
        }
        PushClient.enable(this);
    }

    private void softkey(String side, boolean finishIfMissing) {
        if (webView == null) return;
        // The button fallback keeps the APK compatible with an already-running
        // server that has not yet picked up the Android softkey hook.
        String script = "(function(){" +
                "if(window.dumbtalkAndroidSoftkey)return window.dumbtalkAndroidSoftkey('" + side + "');" +
                "var bar=document.querySelector('nav[aria-label=\"Soft keys\"]');" +
                "var button=bar&&bar.querySelectorAll('button')[" + ("left".equals(side) ? 0 : 2) + "];" +
                "if(!button||!button.textContent.trim())return 'missing';" +
                "var exit=button.textContent.trim()==='Exit';button.click();" +
                "return exit?'exit':'handled';})()";
        webView.evaluateJavascript(script, handled -> {
            if ("\"exit\"".equals(handled) || (finishIfMissing && "\"missing\"".equals(handled))) finish();
        });
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (backOpenedSettings && event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP) backOpenedSettings = false;
            return true;
        }
        if (webView != null) {
            int code = event.getKeyCode();
            if (code == KeyEvent.KEYCODE_BACK) {
                if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 1) {
                    backOpenedSettings = true;
                    showSetup(null);
                    return true;
                }
            }
            if (code == KeyEvent.KEYCODE_SOFT_LEFT || code == KeyEvent.KEYCODE_MENU) {
                if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) softkey("left", false);
                return true;
            }
            if (code == KeyEvent.KEYCODE_SOFT_RIGHT) {
                if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) softkey("right", false);
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override public void onBackPressed() {
        if (webView == null) { super.onBackPressed(); return; }
        softkey("right", true);
    }

    @Override protected void onDestroy() {
        if (audioRequest != null) { audioRequest.deny(); audioRequest = null; }
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (webView != null) webView.destroy();
        network.shutdownNow();
        super.onDestroy();
    }

    @Override protected void onPause() {
        visible = false;
        pushScreen = null;
        pushConversation = null;
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override protected void onResume() {
        super.onResume();
        visible = true;
        if (webView != null) webView.onResume();
    }
}
