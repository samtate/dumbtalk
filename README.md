# DumbTalk

DumbTalk is a small, self-hosted, D-pad-first messaging client for QVGA CloudPhone feature
phones. Signal, Telegram, and WhatsApp share one inbox while each account remains isolated in its
own service data directory.

It supports contacts, groups, text and voice messages, replies, reactions, editing, deletion,
receipts, typing, synced archives, disappearing messages, polls, pins, inline media, attachments,
cross-service forwarding, search, avatars, group management, and Signal safety numbers. Menus
hide operations that a service does not support.

DumbTalk is unofficial and is not affiliated with Signal, Telegram, WhatsApp, or CloudMosa.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/images/unified-inbox.png" alt="Unified inbox showing Signal, Telegram, and WhatsApp chats" width="240"><br><sub>Unified inbox</sub></td>
    <td align="center"><img src="docs/images/whatsapp-conversation.png" alt="A WhatsApp conversation in DumbTalk" width="240"><br><sub>Conversation view</sub></td>
    <td align="center"><img src="docs/images/message-actions.png" alt="Message reactions and actions in DumbTalk" width="240"><br><sub>Message actions</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/main-menu.png" alt="DumbTalk main menu" width="240"><br><sub>Main menu</sub></td>
    <td align="center"><img src="docs/images/connected-services.png" alt="Signal, Telegram, and WhatsApp connected in DumbTalk" width="240"><br><sub>Connected services</sub></td>
  </tr>
</table>

## Get started

You need a Linux x86-64 or ARM64 host with Docker Compose. Download the deployment file and start
the published image—no source checkout or local build is required.

```sh
mkdir dumbtalk
cd dumbtalk
curl -fsSLO https://raw.githubusercontent.com/samtate/dumbtalk/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/samtate/dumbtalk/main/src/client/public/dumbtalk.png
docker compose up -d
```

Open `http://YOUR-SERVER-IP:8787`. The first browser to open a new installation claims it and
receives a generated access key. DumbTalk then guides you through connecting a messaging service.
No `.env` file is required.

The local address is only for configuring DumbTalk in your browser. CloudPhone's servers—not the
phone itself—fetch and process the widget, so the final widget URL must be publicly reachable.

For public HTTPS, CGNAT-friendly options, and the CloudPhone developer-site steps,
follow **[Setup and deployment](docs/setup.md)**.

## Android keypad phones

The [Android frontend](android/README.md) uses the same interface and D-pad navigation on phones
such as the Qin F22 Pro. It connects directly to your existing DumbTalk backend over HTTPS; the
messaging accounts remain on the server. Build the APK from the `android` project, install it on
the phone, and paste your complete widget URL, including its `#` access key.

The Android app can receive message notifications through UnifiedPush. Install a distributor on
the phone and run a backend image built from this version of the source before enabling push.

## Important limitations

- Signal cannot sync earlier history to a newly linked device. DumbTalk shows only messages sent
  or received after linking.
- Calls are not supported.
- Telegram requires an API ID and API hash from
  [my.telegram.org](https://my.telegram.org); DumbTalk asks for them only when Telegram is selected.
- Signal keys, Telegram and WhatsApp sessions, messages, configuration, and decrypted media live
  in `./data`. Keep this directory private and backed up.

## FAQ

### Why must DumbTalk have a public URL if my phone and server are on the same network?

The CloudPhone does not fetch the widget itself. CloudMosa's servers fetch the page, process its
DOM, and send the result to the phone. The widget URL must therefore be reachable from the public
internet over HTTPS. A LAN address can be used by the owner during setup, but never as the final
widget URL. See [Setup and deployment](docs/setup.md) for options that work behind CGNAT without
port forwarding.

The Android app connects directly from the phone, so its HTTPS address only needs to be reachable
from that phone. A private HTTPS address can work if the phone trusts its certificate and can reach
the server on Wi-Fi or through a VPN.

### What does the `#...` part of the widget URL do?

It is a randomly generated 256-bit bearer token. DumbTalk sends it in an API authorization header,
and the URL fragment itself is not sent in HTTP request paths, DNS lookups, or normal referrer
headers. Anyone who obtains the complete URL should nevertheless be treated as having full access
to DumbTalk. Do not publish it, include it in screenshots, or save it in a shared bookmark service.

### Is it safe to expose DumbTalk to the internet?

DumbTalk has application-level safeguards, including a high-entropy access token, constant-time
token comparison, same-origin checks for changes, strict browser security headers, bounded Signal
uploads, authenticated internal WhatsApp webhooks, unprivileged application processes, and
checksum validation for bundled messaging tools.

It has not received a formal third-party security audit and should be treated as a personal
self-hosted service, not a hardened multi-user or enterprise system. Operators should understand
these concerns:

- The first browser to open a fresh installation claims it. Complete initial setup before making
  the service public, or pre-seed `WIDGET_TOKEN` for an automated public deployment.
- DumbTalk is an endpoint for the linked accounts. Messages and media are decrypted on the server;
  service-level end-to-end encryption does not protect them from the DumbTalk host, its
  administrator, or malware on that host.
- The access token is stored in `data/app/config.json`; service credentials, linked-device keys,
  sessions, cached messages, and decrypted media are also stored under `data`. Files are created
  with restrictive permissions, but disk encryption, host access control, and backup security are
  the operator's responsibility.
- Tailscale Funnel, Cloudflare Tunnel, and conventional reverse proxies terminate or relay HTTPS.
  Use providers and proxy hosts you trust, secure their accounts with MFA, and keep the connection
  from the proxy to DumbTalk private.
- Port `8787` binds to all interfaces by default so initial setup works from another computer. Once
  a same-host tunnel or reverse proxy is configured, set `BIND_ADDRESS=127.0.0.1` and use a firewall
  so only the HTTPS entry point is public.
- A valid token permits media uploads and messaging operations. Signal upload sizes are bounded,
  but large or repeated media operations can still consume server memory and disk; WhatsApp's
  upload path currently relies on upstream and host limits rather than its own explicit byte cap.
- `samtate96/dumbtalk:latest` is convenient but is a moving tag. Automatic `signal-cli` updates are
  delayed, checksum-validated, health-checked, and rolled back on failure, but installations still
  trust the DumbTalk Docker Hub account, GitHub Actions, upstream base images, and the Signal,
  Telegram, and WhatsApp bridge dependencies.

Keep the host patched, expose only HTTPS, protect the complete widget URL, review updates, and
maintain tested encrypted backups. Security reports should avoid including tokens, credentials,
messages, session databases, or logs containing personal data.

### Can I restrict the public URL to CloudPhone's servers?

Yes, and this is recommended as defence in depth wherever the public entry point supports it.
CloudMosa publishes the data-centre IP ranges used to fetch widgets, so a reverse proxy or
Cloudflare WAF rule can reject every other source before it reaches DumbTalk. Keep the widget token
as well: the published ranges can change, and an IP allowlist is not a replacement for
authentication. The [setup guide](docs/setup.md#3-restrict-access-to-cloudphones-servers) contains
the current ranges and instructions for Caddy, Cloudflare Tunnel, and Tailscale Funnel.

If you also use the Android app, allow the phone to reach the HTTPS UI and API. A CloudMosa-only
IP rule would block it; you can use a separate HTTPS hostname or add a suitable exception.

### What happens if I lose the widget URL?

The generated token remains in `data/app/config.json`. A server administrator can read it locally
and append it to the public origin as `https://your-host.example/#TOKEN`. Avoid printing it in a
shared terminal session or support log. There is not yet an in-app token rotation or recovery flow.

### Why does Telegram ask for an API ID and API hash before showing a QR code?

The QR code links the user account, but DumbTalk must first identify itself to Telegram as an
MTProto client application. Create the credentials at [my.telegram.org](https://my.telegram.org)
and enter them when prompted. They are stored in `data/telegram/config.json`, not `.env`.

### Can DumbTalk import my existing messages?

Telegram and WhatsApp can sync history according to their linked-device APIs and configured
limits. Signal does not provide existing history to a newly linked device, so its conversations
begin with messages sent or received after DumbTalk is linked.

### Can several people share one installation?

That is not the intended security model. Every browser using the widget URL has the same authority,
and connected accounts share one DumbTalk interface. Use a separate installation and data
directory when users should not have access to one another's accounts or messages.

### How do I update or back up DumbTalk?

Pull and recreate the container as described in [Setup and deployment](docs/setup.md). Back up the
entire `data` directory, preferably with encryption and while the container is stopped or through a
filesystem snapshot so the service databases remain consistent. Test restoration rather than
assuming a backup is usable.

## Development

For the Android keypad frontend, see [android/README.md](android/README.md).

```sh
npm install
npm test
npm run typecheck:client
npm run build:client
```

The client uses Preact, TypeScript, and SCSS modules compiled to browser-compatible static assets.
See [service adapter notes](docs/service-adapters.md) for the internal service contract.

Commits to `main` are tested and published for AMD64 and ARM64 as
[`samtate96/dumbtalk:latest`](https://hub.docker.com/r/samtate96/dumbtalk). The repository must define
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` GitHub Actions secrets.
