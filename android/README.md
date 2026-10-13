# DumbTalk for Android keypad phones

This Android app opens the existing DumbTalk interface from your own server. It does not run Signal, Telegram, or WhatsApp on the phone; those services remain on the self-hosted backend.

## Build and install

1. Open this `android` directory as a project in Android Studio. Use JDK 17, Android SDK 35, and let Studio sync Gradle 8.11.1 and Android Gradle Plugin 8.9.2.
2. Choose **Build > Build APK(s)**. The debug APK is produced under `app/build/outputs/apk/debug/`.
3. Install the APK on the phone using Android Studio or `adb install app/build/outputs/apk/debug/app-debug.apk`.
4. At first launch, paste the complete DumbTalk widget URL, including `#` and its access key. The app checks `/api/status` before saving it. The server must already have been claimed.

Commits to `main` also build a debug APK in GitHub Actions. Download the `dumbtalk-android-debug` artifact from the successful workflow run. It is a debug build for personal testing, not a signed release APK.

The backend must run this updated source version. An older DumbTalk container will still serve the Android interface, but it cannot accept push subscriptions. Rebuild and deploy the backend from this source before enabling notifications.

The app requires HTTPS. If the existing CloudPhone URL is restricted to CloudMosa server IP addresses, permit direct connections from the Android phone too. The server's UI and API stay at the same origin, so the backend does not need CORS changes. The phone needs direct access to the server on Wi-Fi or mobile data.

## UnifiedPush notifications

1. Install and configure a [UnifiedPush distributor](https://unifiedpush.org/users/distributors/) on the phone, such as ntfy or Sunup. Its push server must be reachable from both the phone and the DumbTalk backend.
2. Connect the app to the updated DumbTalk backend and choose **Enable** in the notification prompt. Android 13 and later also asks for notification permission. If needed, hold Back to open connection settings and choose **Enable notifications**.
3. Select a distributor if several are installed. The app registers an encrypted Web Push endpoint with DumbTalk. Hold Back and choose **Send test notification** to check delivery, then return to the home screen and send a real message to a linked account.

You can also trigger a test from the running backend container. From the DumbTalk app directory, run `npm run push:test` to send to every registered device, or `npm run push:test -- DEVICE_ID` for one device. The command prints `{"sent":1,"failed":0}` on success. It reads the device IDs from `/data/app/config.json`; run it after the phone has completed notification registration.

The backend sends an encrypted `new-message` event after a fresh incoming message. The Android notification shows the conversation name and message preview, and fetches the contact or group avatar directly from your DumbTalk server. Mozilla only relays the encrypted payload. Nearby incoming events are coalesced for one second. While the conversation list is open, notifications are suppressed; while a chat is open, only notifications for that chat are suppressed. **Disable notifications** unregisters the phone and removes its backend subscription.

The backend creates VAPID keys on first use and keeps them in `data/app/config.json`. Keep that file in backups; losing it invalidates existing push registrations. `PUSH_VAPID_SUBJECT` is optional and can be set to `mailto:you@example.com` or the server's HTTPS origin; otherwise DumbTalk uses the origin provided during registration. Your HTTPS reverse proxy must accept direct requests from the Android phone.

## Keypad behavior

| Key | Action |
| --- | --- |
| D-pad | Existing DumbTalk focus navigation |
| Centre / Enter | Activate focused control or enter text |
| 1 / Left softkey | Current left softkey action (`1=Menu`, `1=Reply`, etc.) |
| Right softkey / Back | Current right softkey action |
| Hold Back | Open the connection screen |
| Number keys | Text input through the phone's installed input method |

The softkey labels in the web UI remain the source of truth for actions. Text entry depends on the phone's installed keypad input method.

On the Qin F22 Pro, DumberOS assigns Menu to its notification panel by default. Its [key shortcut setting](https://dumbermini.com/blogs/news/learn-about-dumbdroid-development) can move the panel to another key; then DumbTalk can receive Menu for its left softkey. An Android app cannot take a key event that the system has already consumed. The on-screen left softkey also works while the DumberOS shortcut is enabled.

In the Android wrapper, pressing `1` invokes the current left softkey action. It is ignored while a text field is focused so the number key remains available for typing. CloudPhone keeps its original key handling and labels.

## Device test checklist

- Open inbox, menu, services, search, and settings using keys only.
- Open a conversation, reply, send text, and navigate messages with the D-pad.
- Enter text with the physical number keys; verify D-pad behavior while the input method is visible.
- Try an attachment from storage, camera capture, voice recording, and a media download.
- Test Back from each screen, reconnect after losing network, and setup after holding Back.
- Enable UnifiedPush, test a push with the app in the background, and check that a new message from each connected service triggers a notification.
- Repeat on both Wi-Fi and mobile data if the server is exposed beyond the LAN.
