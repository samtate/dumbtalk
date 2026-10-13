import webpush from "web-push";

const MAX_DEVICES = 8;

function encodedPayload(test, payload) {
  const result = { ...payload, event: test ? "test" : "new-message" };
  for (const field of ["title", "sender", "body"]) {
    if (typeof result[field] === "string") result[field] = [...result[field]].slice(0, field === "body" ? 700 : 100).join("");
  }
  while (Buffer.byteLength(JSON.stringify(result)) > 3500 && result.body?.length) {
    result.body = [...result.body].slice(0, -20).join("");
  }
  return JSON.stringify(result);
}

function validSubscription(input) {
  if (!input || typeof input !== "object") return false;
  const { deviceId, endpoint, p256dh, auth } = input;
  if (typeof deviceId !== "string" || !/^[a-f0-9-]{36}$/i.test(deviceId)) return false;
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(p256dh)) return false;
  if (typeof auth !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(auth)) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i.test(url.hostname)) return false;
  } catch { return false; }
  return true;
}

export function createPushService({ config, persist, log }) {
  let delivery = Promise.resolve();

  async function ensureKeys() {
    if (!config.pushVapid?.publicKey || !config.pushVapid?.privateKey) {
      config.pushVapid = webpush.generateVAPIDKeys();
      await persist();
    }
    return config.pushVapid.publicKey;
  }

  async function register(input, origin) {
    if (!validSubscription(input)) throw new Error("Invalid push subscription");
    await ensureKeys();
    const existing = Array.isArray(config.pushSubscriptions) ? config.pushSubscriptions : [];
    const others = existing.filter(item => item.deviceId !== input.deviceId);
    config.pushSubscriptions = [...others, {
      deviceId: input.deviceId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
    }].slice(-MAX_DEVICES);
    if (typeof origin === "string" && /^https:\/\/[^/]+$/.test(origin)) config.pushVapidSubject = origin;
    await persist();
  }

  async function unregister(deviceId) {
    if (typeof deviceId !== "string") throw new Error("Invalid device ID");
    config.pushSubscriptions = (config.pushSubscriptions || []).filter(item => item.deviceId !== deviceId);
    await persist();
  }

  async function sendNow({ test = false, deviceId, payload = {} } = {}) {
    const subscriptions = (config.pushSubscriptions || []).filter(item => !deviceId || item.deviceId === deviceId);
    if (!subscriptions.length) return { sent: 0, failed: 0 };
    const publicKey = await ensureKeys();
    const subject = process.env.PUSH_VAPID_SUBJECT || config.pushVapidSubject || process.env.PUBLIC_ORIGIN;
    if (!subject || !/^(https:\/\/|mailto:)/.test(subject)) {
      log("push skipped: configure PUSH_VAPID_SUBJECT or register from an HTTPS origin");
      return { sent: 0, failed: subscriptions.length };
    }
    let sent = 0;
    let failed = 0;
    const expired = new Set();
    for (const item of subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } },
          encodedPayload(test, payload),
          {
            vapidDetails: { subject, publicKey, privateKey: config.pushVapid.privateKey },
            contentEncoding: "aes128gcm",
            TTL: 3600,
            urgency: "high",
            timeout: 8_000,
          },
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        if (error.statusCode === 404 || error.statusCode === 410) expired.add(item.deviceId);
        log("push delivery failed", error.statusCode || error.code || "network error");
      }
    }
    if (expired.size) {
      config.pushSubscriptions = (config.pushSubscriptions || []).filter(item => !expired.has(item.deviceId));
      await persist();
    }
    return { sent, failed };
  }

  function notifyIncoming(details = {}) {
    // Preserve every message, including messages from different conversations.
    delivery = delivery.catch(() => {}).then(() => sendNow({ payload: details }))
      .catch(error => log("push delivery failed", error.message));
    return delivery;
  }

  return { ensureKeys, register, unregister, sendNow, notifyIncoming };
}
