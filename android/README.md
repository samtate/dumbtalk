# DumbTalk for Android keypad phones

This Android app opens the existing DumbTalk interface from your own server. It does not run Signal, Telegram, or WhatsApp on the phone; those services remain on the self-hosted backend.

## Build and install

1. Open this `android` directory as a project in Android Studio. Use JDK 17, Android SDK 35, and let Studio sync Gradle 8.11.1 and Android Gradle Plugin 8.9.2.
2. Choose **Build > Build APK(s)**. The debug APK is produced under `app/build/outputs/apk/debug/`.
3. Install the APK on the phone using Android Studio or `adb install app/build/outputs/apk/debug/app-debug.apk`.
4. At first launch, paste the complete DumbTalk widget URL, including `#` and its access key. The app checks `/api/status` before saving it. The server must already have been claimed.

The backend must run this updated source version. An older DumbTalk container will still serve the Android interface, but it cannot accept push subscriptions. Rebuild and deploy the backend from this source before enabling notifications.

The app requires HTTPS. If the existing CloudPhone URL is restricted to CloudMosa server IP addresses, permit direct connections from the Android phone too. The server's UI and API stay at the same origin, so the backend does not need CORS changes. The phone needs direct access to the server on Wi-Fi or mobile data.

## UnifiedPush notifications

1. Install and configure a [UnifiedPush distributor](https://unifiedpush.org/users/distributors/) on the phone, such as ntfy or Sunup. Its push server must be reachable from both the phone and the DumbTalk backend.
2. Connect the app to the updated DumbTalk backend and choose **Enable** in the notification prompt. Android 13 and later also asks for notification permission. If needed, hold Back to open connection settings and choose **Enable notifications**.
3. Select a distributor if several are installed. The app registers an encrypted Web Push endpoint with DumbTalk. Hold Back and choose **Send test notification** to check delivery, then return to the home screen and send a real message to a linked account.

The backend sends a generic encrypted `new-message` event after a fresh incoming Signal, Telegram, or WhatsApp message. It displays **New message** without putting message text or contact names into the push payload. Nearby incoming events are coalesced for one second. While the app is open, it does not display a system notification. **Disable notifications** unregisters the phone and removes its backend subscription.

The backend creates VAPID keys on first use and keeps them in `data/app/config.json`. Keep that file in backups; losing it invalidates existing push registrations. `PUSH_VAPID_SUBJECT` is optional and can be set to `mailto:you@example.com` or the server's HTTPS origin; otherwise DumbTalk uses the origin provided during registration. Your HTTPS reverse proxy must accept direct requests from the Android phone.

## Keypad behavior

| Key | Action |
| --- | --- |
| D-pad | Existing DumbTalk focus navigation |
| Centre / Enter | Activate focused control or enter text |
| Left softkey / Menu | Current left softkey action |
| Right softkey / Back | Current right softkey action |
| Hold Back | Open the connection screen |
| Number keys | Text input through the phone's installed input method |

The softkey labels in the web UI remain the source of truth for actions. The F22 Pro's actual key codes should be checked on hardware; some firmware variants remap physical keys. Text entry depends on the phone's installed keypad input method.

## Device test checklist

- Open inbox, menu, services, search, and settings using keys only.
- Open a conversation, reply, send text, and navigate messages with the D-pad.
- Enter text with the physical number keys; verify D-pad behavior while the input method is visible.
- Try an attachment from storage, camera capture, voice recording, and a media download.
- Test Back from each screen, reconnect after losing network, and setup after holding Back.
- Enable UnifiedPush, test a push with the app in the background, and check that a new message from each connected service triggers a notification.
- Repeat on both Wi-Fi and mobile data if the server is exposed beyond the LAN.
