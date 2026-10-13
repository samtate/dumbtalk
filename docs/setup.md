# Setup and deployment

This guide starts with the container, then helps you make it reachable to CloudPhone's servers.
The CloudPhone itself does not fetch the widget—even on Wi-Fi. CloudMosa's servers fetch and
process the DOM, then send the result to the phone. A LAN address can therefore be used for the
owner's setup browser, but it can never be the final widget URL.

You do not need to open router ports, and doing so is usually not the easiest option.

## 1. Start DumbTalk

Install Docker Engine with the Compose plugin on a Linux x86-64 or ARM64 machine, then download
the small deployment file and start the published image:

```sh
mkdir dumbtalk
cd dumbtalk
curl -fsSLO https://raw.githubusercontent.com/samtate/dumbtalk/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/samtate/dumbtalk/main/src/client/public/dumbtalk.png
docker compose up -d
```

Check startup with:

```sh
docker compose ps
docker compose logs -f cloudphone-signal
```

DumbTalk listens on port `8787`. From a browser on the same network, open:

```text
http://SERVER-LAN-IP:8787
```

The first browser to open a fresh installation claims it. DumbTalk generates a random access key,
saves it in `data/app/config.json`, and adds it after `#` in the browser address. Finish connecting
at least one messaging service.

Treat the complete address as a password. Anyone who has it may be able to read your messages.
Do not post it in screenshots, logs, chat, or issue reports.

### Connecting services

- **Signal:** scan the QR code from Signal's **Settings → Linked devices** screen.
- **WhatsApp:** scan a QR code or use the phone-number pairing option.
- **Telegram:** create an application at [my.telegram.org](https://my.telegram.org), then enter its
  numeric API ID and 32-character API hash when prompted. These identify DumbTalk as a Telegram
  client; the next screen links the account by QR code or phone number.

Credentials and sessions are stored inside `./data`, not in `.env`.

## 2. Choose how CloudPhone's servers reach DumbTalk

CloudPhone's processing servers need a stable, publicly reachable HTTPS address. Choose one of
the following paths. A private LAN address and ordinary Tailscale Serve are not valid widget
endpoints.

### A. Tailscale Funnel — simplest when behind CGNAT

Use Funnel when the server is already connected to Tailscale and you want a public HTTPS address
without forwarding router ports. Ordinary Tailscale Serve is private to your tailnet and generally
will not be reachable by a CloudPhone; **Funnel** is the public option.

Install Tailscale on the host, sign in, and then run:

```sh
sudo tailscale funnel --bg http://127.0.0.1:8787
```

Tailscale prints an `https://...ts.net` address. Availability and account requirements are
documented in the official [Tailscale Funnel guide](https://tailscale.com/kb/1223/funnel).

The simple Funnel configuration above does not preserve the public client's source IP for the
HTTP service, so DumbTalk or a conventional HTTP reverse proxy behind it cannot reliably apply a
CloudPhone IP allowlist. The generated widget key remains the access control in this mode. If IP
restriction is important, prefer Cloudflare Tunnel or a conventional reverse proxy below.

Funnel does have an advanced
[PROXY protocol mode](https://tailscale.com/docs/reference/tailscale-cli/funnel) which can preserve
the source address, but it requires a local proxy that understands PROXY protocol v2. Do not enable
it unless that proxy is configured to accept and validate the header; the normal command above is
the appropriate setup for most users.

### B. Cloudflare Tunnel — stable domain without port forwarding

Use this when your DNS is on Cloudflare or you are comfortable moving a hostname there. A named
Cloudflare Tunnel provides a stable HTTPS hostname and works through CGNAT without inbound ports.

1. In Cloudflare Zero Trust, create a tunnel.
2. Install `cloudflared` on the DumbTalk host using the command Cloudflare provides.
3. Add a public hostname such as `chat.example.com`.
4. Point its service to `http://localhost:8787`.
5. Start the tunnel and verify `https://chat.example.com` opens DumbTalk.

Follow Cloudflare's current [tunnel setup guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/).
Quick tunnels with random `trycloudflare.com` addresses are useful for testing but are not stable
enough for a permanent widget URL.

### C. Existing reverse proxy or public VPS

If you already run Caddy, nginx, Traefik, or a NAS reverse-proxy UI, create an HTTPS hostname and
proxy it to `http://127.0.0.1:8787` on the DumbTalk host.

For example, a Caddy site is:

```caddyfile
chat.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

On a public VPS, point the hostname's DNS record at the VPS and allow ports 80 and 443 for the
reverse proxy. Keep DumbTalk itself off the public interface by creating a small `.env` file:

```dotenv
BIND_ADDRESS=127.0.0.1
```

Then recreate the container with `docker compose up -d`.

## 3. Restrict access to CloudPhone's servers

This section applies to the CloudPhone widget. The Android app connects directly from the phone,
so a CloudMosa-only IP allowlist also blocks Android. If you use both frontends, allow the phone
to reach the HTTPS UI and API or give Android a separate HTTPS hostname.

Where possible, configure the public entry point to accept widget requests only from CloudMosa's
published data-centre addresses. This substantially reduces DumbTalk's public attack surface, but
is defence in depth rather than a replacement for the generated widget key.

CloudMosa currently publishes these source addresses:

```text
203.116.120.0/24
203.116.121.0/24
203.116.134.0/24
203.208.133.0/24
45.33.136.0/22
45.33.140.0/22
129.151.177.210
129.151.168.109
129.151.182.81
129.151.161.66
129.151.172.12
129.151.166.100
129.151.183.189
129.151.168.167
84.8.136.215
84.8.138.38
84.8.138.97
84.8.140.68
84.8.132.90
79.72.56.168
79.72.60.209
79.72.59.11
143.47.37.176
143.47.33.53
143.47.55.9
143.47.40.252
```

Check the official [CloudPhone architecture documentation](https://developer.cloudfone.com/docs/guides/architecture/)
when installing and periodically afterwards because CloudMosa says that more ranges may be added.
Filter the actual connection source, not `X-Forwarded-For`: CloudMosa's
[networking documentation](https://developer.cloudfone.com/docs/reference/networking/) says that
header contains the phone user's IP rather than the CloudPhone processing server's IP.

### Caddy or another reverse proxy

For Caddy, replace the simple site from the previous section with the following. Add a trusted
administrator IP to the `remote_ip` matcher only if you also need to open the public hostname from
that address.

```caddyfile
chat.example.com {
    @cloudphone {
        remote_ip 203.116.120.0/24 203.116.121.0/24 203.116.134.0/24 203.208.133.0/24
        remote_ip 45.33.136.0/22 45.33.140.0/22
        remote_ip 129.151.177.210 129.151.168.109 129.151.182.81 129.151.161.66
        remote_ip 129.151.172.12 129.151.166.100 129.151.183.189 129.151.168.167
        remote_ip 84.8.136.215 84.8.138.38 84.8.138.97 84.8.140.68 84.8.132.90
        remote_ip 79.72.56.168 79.72.60.209 79.72.59.11 143.47.37.176
        remote_ip 143.47.33.53 143.47.55.9 143.47.40.252
    }

    handle @cloudphone {
        reverse_proxy 127.0.0.1:8787
    }

    handle {
        respond "Forbidden" 403
    }
}
```

For nginx, Traefik, or a NAS proxy, enter the same CIDRs and addresses in its source-IP allowlist.
If another CDN or load balancer sits in front of the proxy, apply the rule there instead, or first
configure the proxy to trust only that intermediary's source-address header.

### Cloudflare Tunnel

Cloudflare sees the original source address at its edge, so an allowlist works with a Tunnel even
though `cloudflared` connects outbound from your server. In the Cloudflare dashboard, create an IP
list containing the addresses above, then create a WAF custom rule for the DumbTalk hostname with
an expression such as:

```text
(http.host eq "chat.example.com" and not ip.src in $cloudphone_servers)
```

Set the rule action to **Block**. Replace `cloudphone_servers` with the name of your Cloudflare IP
list. See Cloudflare's official
[IP allowlist rule guide](https://developers.cloudflare.com/waf/custom-rules/use-cases/allow-traffic-from-ips-in-allowlist/).

### Tailscale Funnel

The ordinary HTTP Funnel setup in option A cannot enforce this allowlist because the backend does
not receive the original public source address. Advanced operators can use Funnel's PROXY protocol
v2 mode with a compatible local proxy and apply the same ranges there. For a straightforward
IP-restricted deployment, use Cloudflare Tunnel or a conventional reverse proxy instead.

Apply the allowlist only after onboarding and testing the complete public URL. Once enabled, your
ordinary browser will receive `403 Forbidden` from the public hostname unless its address is also
allowed; you can still administer DumbTalk through its private LAN address and saved widget key.

## 4. Build the CloudPhone widget URL

After choosing a public address, keep the generated fragment from the claimed local address.

For example, if onboarding claimed:

```text
http://192.168.1.20:8787/#YOUR_GENERATED_KEY
```

and your public address is:

```text
https://chat.example.com
```

the widget URL is:

```text
https://chat.example.com/#YOUR_GENERATED_KEY
```

Open that complete URL from a device outside your home network, such as a phone with Wi-Fi
disabled. If it loads DumbTalk without showing a configuration error, CloudPhone's servers should
also be able to reach it.

## 5. Add it to CloudPhone

1. Create an unpublished widget in the CloudPhone developer portal.
2. Use the complete public URL, including the `#` access key, as the widget URL.
3. Upload the `dumbtalk.png` file downloaded during installation as the icon.
4. Add the phone's IMEI in the developer portal.
5. Enable developer mode on the phone and open the widget.

The D-pad navigates, Centre selects, Left opens menus, and Right goes back.

## Updates and backups

Update the application with:

```sh
docker compose pull
docker compose up -d
```

Back up the entire `data` directory. It contains the generated access key, linked-device keys,
Telegram and WhatsApp sessions, cached messages, and decrypted media. Anyone with this backup may
be able to access your messages.

The bundled `signal-cli` automatically checks stable releases, validates checksums, health-checks
updates, and rolls back failures. `wacli` is installed from a checksum-verified pinned release.

## Optional configuration

No `.env` file is required. Copy `.env.example` to `.env` only when you need to override defaults.
Common examples are `BIND_ADDRESS`, `HOST_PORT`, and `DEVICE_NAME`. Environment-provided access
tokens and Telegram credentials remain supported for automated deployments and take precedence
over first-run values.
