import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import { prepareSignalCli, rollBackSignalCli } from "./signal-cli-updater.mjs";
import { TelegramService } from "./telegram-service.mjs";
import { WhatsAppService } from "./whatsapp-service.mjs";

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || "/data";
const APP_DIR = join(DATA_DIR, "app");
const CONFIG_PATH = join(APP_DIR, "config.json");
const MEDIA_DIR = join(APP_DIR, "media");
const SIGNAL_DIR = join(DATA_DIR, "signal-cli");
const PUBLIC_DIR = new URL("./public/", import.meta.url).pathname;
const RPC_URL = "http://127.0.0.1:7583/api/v1/rpc";
const EVENTS_URL = "http://127.0.0.1:7583/api/v1/events";
const MAX_MESSAGES = 3000;
const invalidTokenAttempts = new Map();
let messages = [];
let appConfig = {};
let widgetToken = process.env.WIDGET_TOKEN || "";
let appState = { archived: [], favorites: [], muted: [], readThrough: {}, expirations: {}, localNicknames: {}, mindfulUsage: {}, selfProfileName: "", settings: { sendReadReceipts: true, sendTypingIndicators: true, linkPreviews: true, defaultExpiration: 0 } };
let signalProcess;
let signalBinary = "/usr/local/bin/signal-cli";
let signalFallback = signalBinary;
let signalUpdate = { version: "bundled", update: "not-checked" };
let rollbackAttempted = false;
let signalReady = false;
let shuttingDown = false;
let rpcSequence = 0;
const receiveStats = { connected: false, events: 0, messages: 0, lastEventAt: null, lastError: null };
const syncRequestedAccounts = new Set();
const conversationAliases = new Map();
const typingState = new Map();
const identityNames = new Map();
let selfProfileName = "";

function rememberSelfProfileName(name) {
  if (!name || name === "Note to Self") return;
  selfProfileName = name;
  appState.selfProfileName = name;
  void persistState();
}
const viewOnceTokens = new Map();
let stateWrite = Promise.resolve();
await mkdir(APP_DIR, { recursive: true });
await mkdir(MEDIA_DIR, { recursive: true });
await mkdir(SIGNAL_DIR, { recursive: true });
try {
  appConfig = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
} catch {}
widgetToken ||= appConfig.widgetToken || "";
if (widgetToken && Buffer.byteLength(widgetToken) < 43) {
  throw new Error("WIDGET_TOKEN override must be a 256-bit random base64url token");
}

const telegram = new TelegramService({
  dataDir: DATA_DIR,
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
  log: (message, extra) => console.log(`[dumbtalk] ${message}`, extra || ""),
});
const whatsapp = new WhatsAppService({
  dataDir: DATA_DIR,
  log: (message, extra) => console.log(`[dumbtalk] ${message}`, extra || ""),
});

function versionAtLeast(version, minimum) {
  const left = String(version).split(".").map(Number); const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) { if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0); }
  return true;
}
function capabilities() {
  const version = signalUpdate.version === "bundled" ? "0.14.7" : signalUpdate.version;
  return { polls: versionAtLeast(version, "0.13.23"), pins: versionAtLeast(version, "0.14.0"), voiceNotes: true, stickers: true, identities: true, groups: true };
}

function normalizedMentions(items) {
  return (Array.isArray(items) ? items : []).map(mention => {
    const recipient = mention?.recipient && typeof mention.recipient === "object" ? mention.recipient : {};
    const identifier = mention.number || mention.uuid || mention.aci || mention.recipientNumber || mention.recipientUuid || recipient.number || recipient.uuid || recipient.aci || "";
    const suppliedName = [mention.name, mention.profileName, recipient.name, recipient.profileName].find(value => typeof value === "string" && value.trim());
    const identifiers = [mention.number, mention.uuid, mention.aci, recipient.number, recipient.uuid, recipient.aci].filter(value => typeof value === "string" && value);
    const friendlyName = suppliedName && !identifiers.includes(suppliedName) ? suppliedName : "";
    const knownName = identifiers.map(value => identityNames.get(value)).find(Boolean);
    const isSelf = identifiers.some(value => value && identityNames.get(value) === "Note to Self");
    return { ...mention, number: mention.number || recipient.number, uuid: mention.uuid || recipient.uuid || recipient.aci, name: friendlyName || (isSelf ? selfProfileName || "You" : knownName) || identifier || "Someone" };
  });
}
function displayIdentity(value, fallback = "Unknown") {
  const source = value && typeof value === "object" ? value : {};
  const identifier = typeof value === "string" ? value : source.number || source.uuid || source.aci || source.recipient || "";
  const suppliedName = [source.name, source.profileName].find(item => typeof item === "string" && item.trim());
  return suppliedName || identityNames.get(identifier) || identifier || fallback;
}

await telegram.initialize();
await whatsapp.initialize();
try {
  messages = JSON.parse(await readFile(join(APP_DIR, "messages.json"), "utf8"));
} catch {}
try {
  appState = { ...appState, ...JSON.parse(await readFile(join(APP_DIR, "state.json"), "utf8")) };
  appState.settings = { sendReadReceipts: true, sendTypingIndicators: true, linkPreviews: true, defaultExpiration: 0, ...(appState.settings || {}) };
  appState.localNicknames ||= {};
  selfProfileName = appState.selfProfileName || "";
} catch {}

function log(message, extra = "") {
  console.log(`[dumbtalk] ${message}`, extra);
}

signalUpdate = await prepareSignalCli({ dataDir: DATA_DIR, log });
signalBinary = signalUpdate.binary;
signalFallback = signalUpdate.fallback;

function startSignal() {
  signalProcess = spawn(signalBinary, [
    "--data-dir", SIGNAL_DIR,
    "--output", "json",
    "daemon",
    "--http", "127.0.0.1:7583",
    "--receive-mode", "on-start",
    "--ignore-stories",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdoutBuffer = "";
  signalProcess.stdout.on("data", data => {
    stdoutBuffer += data.toString();
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        processReceivePayload(JSON.parse(line), "stdout").catch(error => log("stdout receive failed", error.message));
      } catch {
        log("signal-cli emitted non-JSON stdout");
      }
    }
  });
  signalProcess.stderr.on("data", data => log("signal-cli", data.toString().trim()));
  signalProcess.on("exit", (code, signal) => {
    signalReady = false;
    receiveStats.connected = false;
    if (shuttingDown) return;
    log(`signal-cli exited (${code ?? signal}); restarting in 5 seconds`);
    setTimeout(startSignal, 5000).unref();
  });
  waitForSignal();
}

async function waitForSignal() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:7583/api/v1/check");
      if (response.ok) {
        signalReady = true;
        listenForMessages();
        log("signal-cli daemon ready");
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  log("signal-cli did not become ready in time");
  if (!rollbackAttempted && signalBinary !== signalFallback) {
    rollbackAttempted = true;
    signalBinary = await rollBackSignalCli(DATA_DIR, signalBinary, signalFallback, log);
    signalUpdate = { ...signalUpdate, binary: signalBinary, update: "rolled-back" };
    signalProcess?.kill("SIGKILL");
  }
}

async function scheduledSignalUpdate() {
  if (shuttingDown) return;
  const candidate = await prepareSignalCli({ dataDir: DATA_DIR, log });
  signalUpdate = candidate;
  if (candidate.binary !== signalBinary) {
    signalFallback = candidate.fallback;
    signalBinary = candidate.binary;
    rollbackAttempted = false;
    log(`activating signal-cli ${candidate.version}`);
    signalProcess?.kill("SIGTERM");
  }
}
setInterval(scheduledSignalUpdate, 24 * 60 * 60 * 1000).unref();

async function rpc(method, params = {}, timeoutMs = 30_000) {
  // A freshly started daemon can take a moment to accept its first request.
  // Wait briefly instead of surfacing a transient start-up error to the widget.
  if (!signalReady) {
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    while (!signalReady && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!signalReady) throw new Error("Signal service is starting");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: String(++rpcSequence), method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Signal RPC returned ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || "Signal RPC failed");
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAccounts() {
  try {
    const result = await rpc("listAccounts");
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

async function getAccount() {
  const accounts = await getAccounts();
  const account = accounts[0];
  return typeof account === "string" ? account : account?.number || account?.username || null;
}

async function persistMessages() {
  const tmp = join(APP_DIR, "messages.json.tmp");
  await writeFile(tmp, JSON.stringify(messages.slice(-MAX_MESSAGES)), { mode: 0o600 });
  await rename(tmp, join(APP_DIR, "messages.json"));
}

async function persistState() {
  const snapshot = JSON.stringify(appState);
  stateWrite = stateWrite.catch(() => {}).then(async () => {
    const tmp = join(APP_DIR, "state.json.tmp");
    await writeFile(tmp, snapshot, { mode: 0o600 });
    await rename(tmp, join(APP_DIR, "state.json"));
  });
  return stateWrite;
}

function conversationForData(envelope, data, outgoing, account) {
  const groupId = data?.groupInfo?.groupId;
  const directId = outgoing
    ? data?.destinationNumber || data?.destinationUuid || envelope?.syncMessage?.destinationNumber || envelope?.syncMessage?.destinationUuid || envelope?.syncMessage?.destination
    : envelope?.sourceNumber || envelope?.sourceUuid;
  return groupId ? `group:${groupId}` : directId ? `direct:${directId}` : account ? `direct:${account}` : null;
}

function messageFromEnvelope(payload) {
  const envelope = payload?.envelope || payload?.params?.envelope || payload?.params?.result?.envelope;
  if (!envelope) return null;
  const account = payload?.account || payload?.params?.account || payload?.params?.result?.account;
  if (envelope.sourceNumber === account || envelope.sourceUuid === account) rememberSelfProfileName(envelope.sourceName);
  const sync = envelope.syncMessage;
  const outgoing = sync?.sentMessage;
  const edit = outgoing?.editMessage || envelope.editMessage;
  const data = edit?.dataMessage || outgoing || envelope.dataMessage;
  if (!data) return null;
  const expirationUpdate = Boolean(data.isExpirationUpdate || data.expirationTimerUpdate);
  if (!expirationUpdate && !data.message && !data.attachments?.length && !data.sticker && !data.pollCreateMessage) return null;
  const conversationId = conversationForData(envelope, data, outgoing, account);
  if (!conversationId) {
    log("received message without a conversation identifier");
    return null;
  }
  const quote = data.quote;
  const expirationSeconds = Number(data.expiresInSeconds || 0);
  const changer = outgoing ? "You" : envelope.sourceName || identityNames.get(envelope.sourceNumber || envelope.sourceUuid) || "Someone";
  return {
    id: `${data.timestamp || envelope.timestamp}-${outgoing ? "out" : "in"}`,
    conversationId,
    direction: outgoing ? "out" : "in",
    sender: envelope.sourceName || envelope.sourceNumber || envelope.sourceUuid || account,
    senderId: envelope.sourceNumber || envelope.sourceUuid || account,
    text: expirationUpdate
      ? expirationSeconds ? `${changer} set disappearing messages to ${formatDuration(expirationSeconds)}` : `${changer} turned off disappearing messages`
      : data.message || "",
    timestamp: Number(data.timestamp || envelope.timestamp || Date.now()),
    editedTargetTimestamp: edit ? Number(edit.targetSentTimestamp) : null,
    edited: Boolean(edit),
    expiresInSeconds: expirationUpdate ? 0 : expirationSeconds,
    expiresAt: expirationUpdate ? null : data.expirationStartTimestamp
      ? Number(data.expirationStartTimestamp) + Number(data.expiresInSeconds || 0) * 1000
      : outgoing && data.expiresInSeconds
        ? Number(data.timestamp || envelope.timestamp) + Number(data.expiresInSeconds) * 1000
        : null,
    quote: quote ? {
      timestamp: Number(quote.id || quote.timestamp || 0),
      author: displayIdentity(quote.authorNumber || quote.authorUuid || quote.author, "Message"),
      text: quote.text || quote.message || "",
      mentions: normalizedMentions(quote.mentions),
    } : null,
    reactions: [],
    receipts: {},
    previews: (Array.isArray(data.previews || data.preview) ? (data.previews || data.preview) : []).map(preview => ({
      url: preview.url,
      title: preview.title,
      description: preview.description,
    })),
    system: expirationUpdate,
    expirationUpdate: expirationUpdate ? expirationSeconds : null,
    viewOnce: Boolean(data.viewOnce),
    mentions: normalizedMentions(data.mentions),
    textStyles: data.textStyles || data.textStyle || [],
    sticker: data.sticker ? { packId: data.sticker.packId, stickerId: data.sticker.stickerId, emoji: data.sticker.emoji || "" } : null,
    poll: data.pollCreateMessage ? { question: data.pollCreateMessage.question, options: (data.pollCreateMessage.options || data.pollCreateMessage.option || []).map((option, index) => ({ index, text: option.text || option, votes: [] })), multiple: !data.pollCreateMessage.noMulti, closed: false } : null,
    attachments: (data.attachments || []).map(attachment => ({
      id: attachment.id,
      filename: attachment.filename || "attachment",
      contentType: attachment.contentType || "application/octet-stream",
      size: Number(attachment.size || 0),
      width: attachment.width,
      height: attachment.height,
      caption: attachment.caption,
    })),
  };
}

function formatDuration(seconds) {
  if (seconds % 604800 === 0) return `${seconds / 604800} week${seconds === 604800 ? "" : "s"}`;
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds === 86400 ? "" : "s"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}

async function applyEnvelopeState(payload) {
  const envelope = payload?.envelope || payload?.params?.envelope || payload?.params?.result?.envelope;
  if (!envelope) return false;
  const account = payload?.account || payload?.params?.account || payload?.params?.result?.account;

  // A linked Signal client mirrors its locally-read messages through sync messages.
  // Use those timestamps as the canonical read boundary so DumbTalk starts where the
  // user last left off on another device.
  const syncedReads = envelope.syncMessage?.readMessages || envelope.syncMessage?.readMessage;
  if (syncedReads) {
    let changed = false;
    for (const receipt of Array.isArray(syncedReads) ? syncedReads : [syncedReads]) {
      const timestamp = Number(receipt.timestamp || receipt.sentTimestamp || receipt.messageTimestamp);
      const sender = receipt.senderE164 || receipt.senderNumber || receipt.senderUuid || receipt.senderAci || receipt.sender;
      if (!Number.isFinite(timestamp)) continue;
      const message = messages.find(item => item.direction === "in" && item.timestamp === timestamp && (!sender || item.senderId === sender || item.conversationId === `direct:${sender}`));
      if (!message) continue;
      const conversationId = [...conversationAliases].find(([, aliases]) => aliases.has(message.conversationId))?.[0] || message.conversationId;
      const previous = Number(appState.readThrough[conversationId] || 0);
      if (timestamp > previous) { appState.readThrough[conversationId] = timestamp; changed = true; }
    }
    if (changed) await persistState();
    return true;
  }

  if (envelope.receiptMessage) {
    const receipt = envelope.receiptMessage;
    const status = receipt.isViewed ? "viewed" : receipt.isRead ? "read" : receipt.isDelivery ? "delivered" : null;
    if (status) {
      for (const timestamp of receipt.timestamps || []) {
        const message = messages.find(item => item.timestamp === Number(timestamp) && item.direction === "out");
        if (message) {
          const recipient = envelope.sourceNumber || envelope.sourceUuid || "recipient";
          message.receipts ||= {};
          message.receipts[recipient] = { status, name: envelope.sourceName || identityNames.get(recipient) || recipient, at: Number(receipt.when || Date.now()) };
          const values = Object.values(message.receipts).map(item => item.status);
          message.status = values.includes("viewed") ? "viewed" : values.includes("read") ? "read" : values.includes("delivered") ? "delivered" : status;
        }
      }
      await persistMessages();
    }
    return true;
  }

  if (envelope.typingMessage) {
    const typing = envelope.typingMessage;
    const id = typing.groupId
      ? `group:${typing.groupId}`
      : `direct:${envelope.sourceNumber || envelope.sourceUuid}`;
    const sender = envelope.sourceNumber || envelope.sourceUuid || "unknown";
    const active = typingState.get(id) || new Map();
    if (typing.action === "STARTED") active.set(sender, { expires: Date.now() + 16_000, name: envelope.sourceName || identityNames.get(sender) || "Someone" });
    else active.delete(sender);
    if (active.size) typingState.set(id, active);
    else typingState.delete(id);
    return true;
  }

  const sync = envelope.syncMessage;
  const outgoing = sync?.sentMessage;
  const data = outgoing || envelope.dataMessage;
  const edit = outgoing?.editMessage || envelope.editMessage;
  const remoteDelete = data?.remoteDelete;
  const reaction = data?.reaction;
  const pin = data?.pinMessage || data?.unpinMessage;
  if (pin) {
    const target = messages.find(item => item.timestamp === Number(pin.targetSentTimestamp || pin.targetTimestamp));
    if (target) { target.pinned = !data.unpinMessage && !pin.isUnpin; target.pinExpiresAt = pin.pinDurationInSeconds ? Date.now() + Number(pin.pinDurationInSeconds) * 1000 : null; await persistMessages(); }
    return true;
  }
  const pollVote = data?.pollVoteMessage;
  if (pollVote) {
    const target = messages.find(item => item.timestamp === Number(pollVote.pollTimestamp));
    if (target?.poll) { const voter = envelope.sourceNumber || envelope.sourceUuid || account; target.poll.voteCounts ||= {}; const count = Number(pollVote.voteCount || 1); if (count >= Number(target.poll.voteCounts[voter] || 0)) { target.poll.voteCounts[voter] = count; for (const option of target.poll.options) option.votes = option.votes.filter(item => item !== voter); for (const index of pollVote.option || pollVote.options || []) target.poll.options[Number(index)]?.votes.push(voter); await persistMessages(); } }
    return true;
  }
  const pollTerminate = data?.pollTerminateMessage;
  if (pollTerminate) { const target = messages.find(item => item.timestamp === Number(pollTerminate.pollTimestamp)); if (target?.poll) { target.poll.closed = true; await persistMessages(); } return true; }
  if (reaction) {
    const target = messages.find(item => item.timestamp === Number(reaction.targetSentTimestamp));
    if (target) {
      const authorId = envelope.sourceNumber || envelope.sourceUuid || account || "unknown";
      target.reactions ||= [];
      target.reactions = target.reactions.filter(item => item.authorId !== authorId);
      if (!reaction.isRemove) target.reactions.push({ emoji: reaction.emoji, authorId, author: outgoing ? "You" : envelope.sourceName || identityNames.get(authorId) || authorId, own: Boolean(outgoing) });
      await persistMessages();
    }
    return true;
  }
  if (remoteDelete) {
    const target = messages.find(item => item.timestamp === Number(remoteDelete.timestamp));
    if (target) {
      target.deleted = true;
      target.text = "Message deleted";
      target.attachments = [];
      await persistMessages();
    }
    return true;
  }
  if (edit) {
    const edited = messageFromEnvelope(payload);
    const target = messages.find(item => item.timestamp === Number(edit.targetSentTimestamp));
    if (target && edited) {
      target.text = edited.text;
      target.attachments = edited.attachments;
      target.edited = true;
      await persistMessages();
      return true;
    }
  }
  return false;
}

async function processReceivePayload(payload, source) {
  receiveStats.events += 1;
  receiveStats.lastEventAt = Date.now();
  const envelope = payload?.envelope || payload?.params?.envelope || payload?.params?.result?.envelope;
  const kind = envelope?.syncMessage?.sentMessage
    ? "sent-sync"
    : envelope?.dataMessage
      ? "incoming-message"
      : payload?.method || "other";
  log(`receive event (${kind}, ${source})`);
  if (await applyEnvelopeState(payload)) return;
  const message = messageFromEnvelope(payload);
  const duplicateSystem = message?.system && messages.some(item => item.system && item.conversationId === message.conversationId && item.expirationUpdate === message.expirationUpdate && Math.abs(item.timestamp - message.timestamp) < 15_000);
  if (message && !duplicateSystem && !messages.some(item => item.id === message.id)) {
    messages.push(message);
    if (message.system && message.expirationUpdate !== null) {
      appState.expirations[message.conversationId] = message.expirationUpdate;
      await persistState();
    }
    if (message.direction === "in") {
      const canonical = [...conversationAliases].find(([, aliases]) => aliases.has(message.conversationId))?.[0];
      const before = appState.archived.length;
      appState.archived = appState.archived.filter(id => id !== message.conversationId && id !== canonical);
      if (appState.archived.length !== before) await persistState();
    }
    receiveStats.messages += 1;
    await persistMessages();
  }
}

let listening = false;
async function listenForMessages() {
  if (listening) return;
  listening = true;
  while (signalReady) {
    try {
      const response = await fetch(EVENTS_URL, { headers: { accept: "text/event-stream" } });
      if (!response.ok || !response.body) throw new Error(`events returned ${response.status}`);
      receiveStats.connected = true;
      receiveStats.lastError = null;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (signalReady) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Java's SSE server uses CRLF on some platforms. Normalize it before
        // looking for the blank line that terminates an event. Previously the
        // stream stayed buffered forever when it contained \r\n\r\n.
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event.split("\n").filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).trim()).join("\n");
          if (!data) continue;
          const payload = JSON.parse(data);
          await processReceivePayload(payload, "sse");
        }
      }
    } catch (error) {
      receiveStats.connected = false;
      receiveStats.lastError = error.message;
      log("receive stream reconnect", error.message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  listening = false;
}

function tokenMatches(req) {
  const supplied = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!supplied) return false;
  const expected = Buffer.from(widgetToken);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function allowInvalidTokenAttempt(req) {
  const now = Date.now(); const ip = requestIp(req);
  const attempt = invalidTokenAttempts.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now >= attempt.resetAt) { attempt.count = 0; attempt.resetAt = now + 60_000; }
  attempt.count += 1; invalidTokenAttempts.set(ip, attempt);
  return attempt.count <= 30;
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === process.env.PUBLIC_ORIGIN || origin === appConfig.publicOrigin) return true;

  // Also accept the origin through which this request actually arrived. This
  // supports local setup and reverse proxies without weakening the cross-site
  // check: a browser cannot choose a Host header independently of its target.
  const forwardedHost = req.headers["x-forwarded-host"]?.split(",")[0].trim();
  const host = forwardedHost || req.headers.host;
  const forwardedProto = req.headers["x-forwarded-proto"]?.split(",")[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? "https" : "http");
  return Boolean(host) && origin === `${protocol}://${host}`;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 1_000_000) throw new Error("Request too large");
  }
  return value ? JSON.parse(value) : {};
}

async function persistConfig() {
  const temporary = `${CONFIG_PATH}.tmp`;
  await writeFile(temporary, JSON.stringify(appConfig), { mode: 0o600 });
  await rename(temporary, CONFIG_PATH);
}

async function setup(req, res, url) {
  if (url.pathname === "/api/setup/status" && req.method === "GET") {
    return json(res, 200, { claimed: Boolean(widgetToken) });
  }
  if (url.pathname === "/api/setup/claim" && req.method === "POST") {
    if (!requireSameOrigin(req)) return json(res, 403, { error: "Origin rejected" });
    if (widgetToken) return json(res, 409, { error: "This DumbTalk installation has already been claimed" });

    // Assignment happens before the first await, so simultaneous requests cannot
    // both claim a fresh installation in Node's single event loop.
    widgetToken = randomBytes(32).toString("base64url");
    appConfig = { ...appConfig, widgetToken };
    try {
      await persistConfig();
    } catch (error) {
      widgetToken = "";
      delete appConfig.widgetToken;
      throw error;
    }
    return json(res, 201, { token: widgetToken });
  }
  return json(res, 404, { error: "Not found" });
}

async function api(req, res, url) {
  if (url.pathname.startsWith("/api/setup/")) return setup(req, res, url);
  if (!tokenMatches(req)) {
    if (!allowInvalidTokenAttempt(req)) await new Promise(resolve => setTimeout(resolve, 250));
    // Deliberately indistinguishable whether the token was absent, wrong, or rate-limited.
    return json(res, 404, { error: "Not found" });
  }
  if (req.method !== "GET" && !requireSameOrigin(req)) return json(res, 403, { error: "Origin rejected" });

  if (url.pathname.startsWith("/api/services/telegram")) {
    return telegram.handle(req, res, url, { body, json });
  }
  if (url.pathname.startsWith("/api/services/whatsapp")) {
    return whatsapp.handle(req, res, url, { body, json });
  }

  if (url.pathname === "/api/mindful" && req.method === "GET") {
    const day = url.searchParams.get("day");
    return json(res, 200, { usage: day ? appState.mindfulUsage?.[day] || null : null });
  }

  if (url.pathname === "/api/local-nicknames" && req.method === "GET") {
    const conversationId = String(url.searchParams.get("conversationId") || "");
    if (!conversationId || conversationId.length > 300) return json(res, 400, { error: "Invalid conversation" });
    return json(res, 200, { nicknames: appState.localNicknames?.[conversationId] || {} });
  }

  if (url.pathname === "/api/local-nicknames" && req.method === "POST") {
    const input = await body(req);
    const conversationId = String(input.conversationId || "");
    if (!conversationId || conversationId.length > 300) return json(res, 400, { error: "Invalid conversation" });
    const nicknames = {};
    for (const [name, nickname] of Object.entries(input.nicknames || {})) {
      const source = String(name).trim();
      const local = String(nickname).trim();
      if (source && source.length <= 160 && local && local.length <= 40) nicknames[source] = local;
    }
    appState.localNicknames ||= {};
    if (Object.keys(nicknames).length) appState.localNicknames[conversationId] = nicknames;
    else delete appState.localNicknames[conversationId];
    await persistState();
    return json(res, 200, { nicknames });
  }
  if (url.pathname === "/api/mindful" && req.method === "POST") {
    const input = await body(req);
    const day = typeof input.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : null;
    if (!day) return json(res, 400, { error: "Invalid day" });
    const usage = input.usage && typeof input.usage === "object" ? input.usage : {};
    appState.mindfulUsage ||= {};
    appState.mindfulUsage[day] = {
      checks: Math.max(0, Math.min(99, Number(usage.checks) || 0)),
      activeMs: Math.max(0, Math.min(86_400_000, Number(usage.activeMs) || 0)),
      launches: Array.isArray(usage.launches) ? usage.launches.filter(Number.isFinite).slice(-24) : [],
      nudges: usage.nudges && typeof usage.nudges === "object" ? usage.nudges : {},
      lastLaunch: Math.max(0, Number(usage.lastLaunch) || 0),
    };
    for (const key of Object.keys(appState.mindfulUsage)) if (key !== day && key < new Date(Date.now() - 7 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Europe/London" })) delete appState.mindfulUsage[key];
    await persistState();
    return json(res, 200, { usage: appState.mindfulUsage[day] });
  }
  if (url.pathname === "/api/status" && req.method === "GET") {
    const accounts = signalReady ? await getAccounts() : [];
    const telegramStatus = telegram.statusPayload();
    const whatsappStatus = whatsapp.statusPayload();
    return json(res, 200, {
      signalReady,
      linked: accounts.length > 0,
      anyLinked: accounts.length > 0 || telegramStatus.connected || whatsappStatus.connected,
      telegram: telegramStatus,
      whatsapp: whatsappStatus,
      accounts,
      receive: { ...receiveStats, subscribed: receiveStats.connected },
      settings: appState.settings,
      signalCli: { version: signalUpdate.version, update: signalUpdate.update, error: signalUpdate.error || null },
      capabilities: capabilities(),
    });
  }
  if (url.pathname === "/api/link/start" && req.method === "POST") {
    const result = await rpc("startLink");
    const uri = result.deviceLinkUri;
    return json(res, 200, { uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) });
  }
  if (url.pathname === "/api/link/finish" && req.method === "POST") {
    const input = await body(req);
    await rpc("finishLink", {
      deviceLinkUri: input.uri,
      deviceName: process.env.DEVICE_NAME || "DumbTalk",
    }, 180_000);
    const account = await getAccount();
    if (account) {
      await rpc("sendSyncRequest", { account }).catch(error => log("initial sync request failed", error.message));
      syncRequestedAccounts.add(account);
    }
    return json(res, 200, { linked: true });
  }
  if (url.pathname === "/api/services/signal/disconnect" && req.method === "POST") {
    const input = await body(req);
    if (input.confirm !== "disconnect-signal") return json(res, 400, { error: "Confirmation required" });
    const account = await getAccount();
    if (!account) return json(res, 200, { disconnected: true });

    // This removes only DumbTalk's linked-device keys. It does not unregister or
    // delete the user's primary Signal account.
    await rpc("deleteLocalAccountData", { account, ignoreRegistered: true }, 120_000);
    messages = [];
    appState = {
      ...appState,
      archived: [],
      favorites: [],
      muted: [],
      readThrough: {},
      expirations: {},
    };
    syncRequestedAccounts.delete(account);
    conversationAliases.clear();
    typingState.clear();
    identityNames.clear();
    viewOnceTokens.clear();
    await rm(MEDIA_DIR, { recursive: true, force: true });
    await mkdir(MEDIA_DIR, { recursive: true });
    await Promise.all([persistMessages(), persistState()]);
    return json(res, 200, { disconnected: true });
  }
  if (url.pathname === "/api/conversations" && req.method === "GET") {
    const account = await getAccount();
    if (!account) return json(res, 409, { error: "Signal is not linked" });
    if (!syncRequestedAccounts.has(account)) {
      syncRequestedAccounts.add(account);
      rpc("sendSyncRequest", { account }).catch(error => log("sync request failed", error.message));
    }
    const params = { account };
    const [contacts, groups, identities] = await Promise.all([
      rpc("listContacts", { ...params, allRecipients: true }).catch(() => []),
      rpc("listGroups", params).catch(() => []),
      rpc("listIdentities", params).catch(() => []),
    ]);
    const identityByRecipient = new Map((identities || []).map(identity => [identity.number || identity.uuid || identity.recipient, identity]));
    const showArchived = url.searchParams.get("archived") === "1";
    const byAlias = new Map();
    const allConversations = [];
    const archivedAliases = new Set();
    conversationAliases.clear();

    const joinedName = (...values) => values.filter(Boolean).join(" ").trim();
    const contactName = contact =>
      contact.name ||
      contact.nickName ||
      joinedName(contact.nickGivenName, contact.nickFamilyName) ||
      joinedName(contact.givenName, contact.familyName) ||
      contact.profileName ||
      joinedName(contact.profile?.givenName, contact.profile?.familyName) ||
      contact.username ||
      contact.number ||
      contact.uuid ||
      contact.aci ||
      "Unknown contact";

    for (const contact of contacts || []) {
      const identifiers = [...new Set([
        contact.number,
        contact.uuid,
        contact.aci,
        contact.pni,
        contact.recipientAddress?.number,
        contact.recipientAddress?.uuid,
      ].filter(Boolean))];
      const target = contact.number || contact.uuid || contact.aci || identifiers[0];
      if (!target) continue;
      const aliases = identifiers.map(identifier => `direct:${identifier}`);
      const noteToSelf = identifiers.includes(account);
      const profileName = contactName(contact);
      if (noteToSelf && profileName !== account) rememberSelfProfileName(profileName);
      const name = noteToSelf ? "Note to Self" : profileName;
      for (const identifier of identifiers) identityNames.set(identifier, name);
      const item = {
        id: `direct:${target}`,
        kind: "direct",
        target,
        name,
        archived: appState.archived.includes(`direct:${target}`) || aliases.some(alias => appState.archived.includes(alias)),
        avatar: `/api/avatar/direct/${encodeURIComponent(target)}`,
        expiration: Number(appState.expirations[`direct:${target}`] || 0),
        noteToSelf,
        blocked: Boolean(contact.isBlocked ?? contact.blocked),
        messageRequest: Boolean(contact.isMessageRequest ?? contact.messageRequest),
        identityChanged: identifiers.some(identifier => { const identity = identityByRecipient.get(identifier); return identity && (identity.trusted === false || String(identity.trustLevel || identity.trust || "").toLowerCase().includes("untrusted")); }),
      };
      allConversations.push(item);
      conversationAliases.set(item.id, new Set(aliases));
      for (const alias of aliases) {
        byAlias.set(alias, item);
        if (item.archived) archivedAliases.add(alias);
      }
    }
    if (!allConversations.some(item => item.noteToSelf)) {
      const item = { id: `direct:${account}`, kind: "direct", target: account, name: "Note to Self", noteToSelf: true, archived: appState.archived.includes(`direct:${account}`), expiration: Number(appState.expirations[`direct:${account}`] || 0), avatar: null };
      allConversations.push(item);
      byAlias.set(item.id, item);
      conversationAliases.set(item.id, new Set([item.id]));
    }
    for (const group of groups || []) {
      if (!group.id) continue;
      const invited = group.isMember === false && [...(group.pendingMembers || []), ...(group.requestingMembers || [])].includes(account);
      if (group.isMember === false && !invited) continue;
      const item = {
        id: `group:${group.id}`,
        kind: "group",
        target: group.id,
        name: group.name || "Signal group",
        archived: appState.archived.includes(`group:${group.id}`),
        avatar: `/api/avatar/group/${encodeURIComponent(group.id)}`,
        expiration: Number(appState.expirations[`group:${group.id}`] || 0),
        members: (group.members || []).map(member => {
          const source = member && typeof member === "object" ? member : {};
          const id = typeof member === "string" ? member : source.number || source.uuid || source.aci || source.id || "";
          return { id, name: displayIdentity(source, identityNames.get(id) || id || "Unknown member") };
        }),
        admins: (group.admins || []).map(admin => typeof admin === "string" ? admin : admin?.number || admin?.uuid || admin?.aci || admin?.id).filter(Boolean),
        description: group.description || "",
        inviteLink: group.groupInviteLink || "",
        blocked: Boolean(group.isBlocked ?? group.blocked),
        permissions: group.permissions || group.accessControl || {},
        invited,
      };
      allConversations.push(item);
      byAlias.set(item.id, item);
      conversationAliases.set(item.id, new Set([item.id]));
      if (item.archived) archivedAliases.add(item.id);
    }
    const now = Date.now();
    for (const item of messages.filter(message => !message.expiresAt || message.expiresAt > now)) {
      if (!showArchived && archivedAliases.has(item.conversationId)) continue;
      if (!byAlias.has(item.conversationId)) {
        const [kind, ...target] = item.conversationId.split(":");
        const fallbackTarget = target.join(":");
        const conversation = { id: item.conversationId, kind, target: fallbackTarget, name: identityNames.get(fallbackTarget) || item.sender || fallbackTarget, archived: appState.archived.includes(item.conversationId), avatar: `/api/avatar/${kind}/${encodeURIComponent(fallbackTarget)}` };
        allConversations.push(conversation);
        byAlias.set(item.conversationId, conversation);
        conversationAliases.set(conversation.id, new Set([conversation.id]));
      }
      const conversation = byAlias.get(item.conversationId);
      if (!conversation.last || item.timestamp > conversation.last.timestamp) conversation.last = item;
    }
    const archivedCount = allConversations.filter(item => item.archived).length;
    for (const conversation of allConversations) {
      const aliases = conversationAliases.get(conversation.id) || new Set([conversation.id]);
      const activeTypers = [...aliases].flatMap(alias => [...(typingState.get(alias)?.values() || [])]).filter(item => item.expires > now);
      conversation.typing = activeTypers.map(item => item.name);
      conversation.unread = messages.filter(message => aliases.has(message.conversationId) && message.direction === "in" && message.timestamp > Number(appState.readThrough[conversation.id] || 0)).length;
    }
    const conversations = allConversations
      .filter((item, index, list) => list.indexOf(item) === index)
      .filter(item => showArchived ? item.archived : !item.archived)
      .map(item => ({ ...item, favorite: appState.favorites.includes(item.id), muted: (appState.muted || []).includes(item.id) }))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.last?.timestamp || 0) - (a.last?.timestamp || 0));
    return json(res, 200, { account, conversations, archivedCount, showingArchived: showArchived });
  }
  if (url.pathname.startsWith("/api/messages/") && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.slice(14));
    const aliases = conversationAliases.get(id) || new Set([id]);
    const now = Date.now();
    const typing = [...aliases].flatMap(alias => [...(typingState.get(alias)?.values() || [])]).filter(item => item.expires > now).map(item => item.name);
    const before = Number(url.searchParams.get("before") || Infinity);
    const limit = Math.max(20, Math.min(200, Number(url.searchParams.get("limit") || 100)));
    const available = messages.filter(item => aliases.has(item.conversationId) && item.timestamp < before && (!item.expiresAt || item.expiresAt > now));
    const visible = available.slice(-limit).map(item => {
      const source = item.quote ? messages.find(candidate => candidate.timestamp === Number(item.quote.timestamp)) : null;
      const enriched = { ...item, mentions: normalizedMentions(item.mentions) };
      if (item.quote) enriched.quote = { ...item.quote, author: displayIdentity(item.quote.author, "Message"), text: source?.text || item.quote.text, mentions: normalizedMentions(item.quote.mentions?.length ? item.quote.mentions : source?.mentions) };
      return enriched;
    });
    return json(res, 200, { messages: visible, typing, hasMore: available.length > limit, readThrough: Number(appState.readThrough[id] || 0) });
  }
  if (url.pathname === "/api/search" && req.method === "GET") {
    const query = String(url.searchParams.get("q") || "").trim().toLocaleLowerCase();
    if (query.length < 2) return json(res, 200, { results: [] });
    const requestedConversation = String(url.searchParams.get("conversationId") || "");
    const requestedAliases = requestedConversation ? conversationAliases.get(requestedConversation) || new Set([requestedConversation]) : null;
    const results = messages.filter(item => (!requestedAliases || requestedAliases.has(item.conversationId)) && item.text?.toLocaleLowerCase().includes(query)).slice(-100).reverse().map(item => ({ id: item.id, conversationId: [...conversationAliases].find(([, aliases]) => aliases.has(item.conversationId))?.[0] || item.conversationId, sender: item.direction === "out" ? "You" : item.sender, text: item.text, timestamp: item.timestamp }));
    return json(res, 200, { results });
  }
  if (url.pathname === "/api/read" && req.method === "POST") {
    const input = await body(req);
    const account = await getAccount();
    const conversationId = String(input.conversationId);
    const aliases = conversationAliases.get(conversationId) || new Set([conversationId]);
    const previousReadThrough = Number(appState.readThrough[conversationId] || 0);
    const unread = messages.filter(item => aliases.has(item.conversationId) && item.direction === "in" && item.timestamp > previousReadThrough && item.senderId);
    const bySender = new Map();
    for (const message of unread) {
      if (!bySender.has(message.senderId)) bySender.set(message.senderId, []);
      bySender.get(message.senderId).push(message.timestamp);
    }
    for (const message of unread) {
      message.status = "read";
      if (message.expiresInSeconds && !message.expiresAt) message.expiresAt = Date.now() + message.expiresInSeconds * 1000;
    }
    appState.readThrough[conversationId] = Math.max(previousReadThrough, ...unread.map(message => message.timestamp));
    if (unread.length) await persistMessages();
    await persistState();
    const receiptErrors = [];
    if (appState.settings.sendReadReceipts) {
      for (const [recipient, targetTimestamps] of bySender) {
        try {
          await rpc("sendReceipt", { account, recipient, targetTimestamps, type: "read" });
        } catch (error) {
          receiptErrors.push({ recipient, error: error.message });
          log("read receipt failed", error.message);
        }
      }
    }
    return json(res, 200, { read: unread.length, receiptErrors: receiptErrors.length });
  }
  if (url.pathname === "/api/typing" && req.method === "POST") {
    const input = await body(req);
    const account = await getAccount();
    const params = input.kind === "group"
      ? { account, groupIds: [input.target], stop: Boolean(input.stop) }
      : { account, recipients: [input.target], stop: Boolean(input.stop) };
    if (appState.settings.sendTypingIndicators) await rpc("sendTyping", params);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/conversation/archive" && req.method === "POST") {
    const input = await body(req);
    const id = String(input.conversationId || "");
    if (!/^(direct|group):.+/.test(id)) return json(res, 400, { error: "Invalid conversation" });
    const archived = new Set(appState.archived);
    if (input.archived) archived.add(id);
    else archived.delete(id);
    appState.archived = [...archived];
    await persistState();
    return json(res, 200, { archived: Boolean(input.archived) });
  }
  if (url.pathname === "/api/conversation/favorite" && req.method === "POST") {
    const input = await body(req); const id = String(input.conversationId || ""); const favorites = new Set(appState.favorites || []); if (input.favorite) favorites.add(id); else favorites.delete(id); appState.favorites = [...favorites]; await persistState(); return json(res, 200, { favorite: Boolean(input.favorite) });
  }
  if (url.pathname === "/api/conversation/mute" && req.method === "POST") {
    const input = await body(req); const id = String(input.conversationId || "");
    if (!/^(direct|group):.+/.test(id)) return json(res, 400, { error: "Invalid conversation" });
    const muted = new Set(appState.muted || []); if (input.muted) muted.add(id); else muted.delete(id); appState.muted = [...muted]; await persistState(); return json(res, 200, { muted: Boolean(input.muted) });
  }
  if (url.pathname === "/api/conversation/block" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const params = input.kind === "group" ? { account, groupIds: [input.target] } : { account, recipients: [input.target] };
    await rpc(input.blocked ? "block" : "unblock", params); return json(res, 200, { blocked: Boolean(input.blocked) });
  }
  if (url.pathname === "/api/message-request" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const params = { account, type: input.type === "delete" ? "delete" : "accept", ...(input.kind === "group" ? { groupIds: [input.target] } : { recipients: [input.target] }) };
    await rpc("sendMessageRequestResponse", params); return json(res, 200, { ok: true });
  }
  if (url.pathname.startsWith("/api/identity/") && req.method === "GET") {
    const recipient = decodeURIComponent(url.pathname.slice(14)); const account = await getAccount(); const result = await rpc("listIdentities", { account, number: recipient }); return json(res, 200, { identities: Array.isArray(result) ? result : [result].filter(Boolean) });
  }
  if (url.pathname === "/api/identity/trust" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const safety = String(input.safetyNumber || "").replace(/\s/g, "");
    if (!/^\d{60}$/.test(safety)) return json(res, 400, { error: "Enter the 60-digit safety number" });
    await rpc("trust", { account, recipient: input.recipient, verifiedSafetyNumber: safety }); return json(res, 200, { verified: true });
  }
  if (url.pathname === "/api/group/update" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const params = { account, groupId: input.groupId };
    for (const key of ["name", "description", "link", "setPermissionAddMember", "setPermissionEditDetails", "setPermissionSendMessages"]) if (input[key] !== undefined) params[key] = input[key];
    if (input.member?.length) params.member = input.member; if (input.removeMember?.length) params.removeMember = input.removeMember; if (input.admin?.length) params.admin = input.admin; if (input.removeAdmin?.length) params.removeAdmin = input.removeAdmin;
    const result = await rpc("updateGroup", params); return json(res, 200, { result });
  }
  if (url.pathname === "/api/group/leave" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); await rpc("quitGroup", { account, groupId: input.groupId, delete: false, admins: [] }); return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/settings" && req.method === "GET") {
    return json(res, 200, { settings: appState.settings });
  }
  if (url.pathname === "/api/settings" && req.method === "POST") {
    const input = await body(req);
    if (typeof input.sendReadReceipts === "boolean") appState.settings.sendReadReceipts = input.sendReadReceipts;
    if (typeof input.sendTypingIndicators === "boolean") appState.settings.sendTypingIndicators = input.sendTypingIndicators;
    if (typeof input.linkPreviews === "boolean") appState.settings.linkPreviews = input.linkPreviews;
    if (input.defaultExpiration !== undefined) appState.settings.defaultExpiration = Math.max(0, Math.min(2_592_000, Number(input.defaultExpiration) || 0));
    const account = await getAccount();
    await rpc("updateConfiguration", { account, readReceipts: appState.settings.sendReadReceipts, typingIndicators: appState.settings.sendTypingIndicators, linkPreviews: appState.settings.linkPreviews });
    await persistState();
    return json(res, 200, { settings: appState.settings });
  }
  if (url.pathname === "/api/conversation/expiration" && req.method === "POST") {
    const input = await body(req);
    const account = await getAccount();
    const expiration = Math.max(0, Math.min(2_592_000, Number(input.expiration) || 0));
    if (input.kind === "group") await rpc("updateGroup", { account, groupId: input.target, expiration });
    else await rpc("updateContact", { account, recipient: input.target, expiration });
    const conversationId = `${input.kind}:${input.target}`;
    appState.expirations[conversationId] = expiration;
    const timestamp = Date.now();
    messages.push({ id: `${timestamp}-system`, conversationId, direction: "system", sender: "You", senderId: account, text: expiration ? `You set disappearing messages to ${formatDuration(expiration)}` : "You turned off disappearing messages", timestamp, system: true, expirationUpdate: expiration, attachments: [], reactions: [], receipts: {} });
    await persistMessages();
    await persistState();
    return json(res, 200, { expiration });
  }
  if (url.pathname === "/api/group/create" && req.method === "POST") {
    const input = await body(req);
    const account = await getAccount();
    const name = String(input.name || "").trim();
    const members = [...new Set((input.members || []).map(String).filter(Boolean))];
    if (!name || name.length > 100) return json(res, 400, { error: "Group name must be 1–100 characters" });
    if (!members.length) return json(res, 400, { error: "Choose at least one member" });
    const result = await rpc("updateGroup", { account, name, member: members });
    return json(res, 200, { result });
  }
  if (url.pathname === "/api/message/reaction" && req.method === "POST") {
    const input = await body(req);
    const account = await getAccount();
    const targetTimestamp = Number(input.timestamp);
    const existing = messages.find(item => item.timestamp === targetTimestamp && !item.deleted);
    if (!existing) return json(res, 404, { error: "Message not found" });
    const emoji = String(input.emoji || "");
    if (!emoji || emoji.length > 16) return json(res, 400, { error: "Choose a reaction" });
    const params = {
      account,
      targetTimestamp,
      targetAuthor: existing.direction === "out" ? account : existing.senderId,
      emoji,
      remove: Boolean(input.remove),
      ...(input.kind === "group" ? { groupIds: [input.target] } : { recipients: [input.target] }),
    };
    await rpc("sendReaction", params);
    existing.reactions ||= [];
    existing.reactions = existing.reactions.filter(item => item.authorId !== account);
    if (!input.remove) existing.reactions.push({ emoji, authorId: account, author: "You", own: true });
    await persistMessages();
    return json(res, 200, { message: existing });
  }
  if (url.pathname === "/api/message/pin" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const existing = messages.find(item => item.timestamp === Number(input.timestamp));
    if (!existing) return json(res, 404, { error: "Message not found" });
    const method = input.pinned ? "sendPinMessage" : "sendUnpinMessage";
    const params = { account, targetTimestamp: existing.timestamp, targetAuthor: existing.direction === "out" ? account : existing.senderId, ...(input.kind === "group" ? { groupIds: [input.target] } : { recipients: [input.target] }) };
    if (input.pinned) params.pinDuration = input.duration ? Number(input.duration) : -1;
    await rpc(method, params); existing.pinned = Boolean(input.pinned); existing.pinExpiresAt = input.pinned && Number(input.duration) > 0 ? Date.now() + Number(input.duration) * 1000 : null; await persistMessages();
    return json(res, 200, { message: existing });
  }
  if (url.pathname.startsWith("/api/pins/") && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.slice(10)); const aliases = conversationAliases.get(id) || new Set([id]); const now = Date.now();
    return json(res, 200, { pins: messages.filter(item => aliases.has(item.conversationId) && item.pinned && (!item.pinExpiresAt || item.pinExpiresAt > now)) });
  }
  if (url.pathname === "/api/poll/create" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const question = String(input.question || "").trim(); const options = (input.options || []).map(value => String(value).trim()).filter(Boolean);
    if (!question || options.length < 2 || options.length > 10) return json(res, 400, { error: "Polls require a question and 2–10 options" });
    const common = { account, question, option: options, noMulti: !input.multiple }; const params = input.kind === "group" ? { ...common, groupIds: [input.target] } : { ...common, recipients: [input.target] };
    const result = await rpc("sendPollCreate", params); const timestamp = Number(result?.timestamp || Date.now());
    const sent = { id: `${timestamp}-out`, conversationId: `${input.kind}:${input.target}`, direction: "out", sender: account, senderId: account, text: "", timestamp, status: "sent", receipts: {}, reactions: [], attachments: [], poll: { question, options: options.map((text, index) => ({ index, text, votes: [] })), multiple: Boolean(input.multiple), closed: false } };
    messages.push(sent); await persistMessages(); return json(res, 200, { message: sent });
  }
  if (url.pathname === "/api/poll/vote" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const poll = messages.find(item => item.timestamp === Number(input.timestamp) && item.poll);
    if (!poll || poll.poll.closed) return json(res, 404, { error: "Poll unavailable" }); const option = [...new Set((input.options || []).map(Number))];
    const voteCount = Number(poll.poll.ownVoteCount || 0) + 1; const common = { account, pollTimestamp: poll.timestamp, pollAuthor: poll.direction === "out" ? account : poll.senderId, option, voteCount }; const params = input.kind === "group" ? { ...common, groupIds: [input.target] } : { ...common, recipients: [input.target] };
    await rpc("sendPollVote", params); poll.poll.ownVoteCount = voteCount; for (const choice of poll.poll.options) choice.votes = choice.votes.filter(voter => voter !== account); for (const index of option) poll.poll.options[index]?.votes.push(account); await persistMessages(); return json(res, 200, { message: poll });
  }
  if (url.pathname === "/api/poll/close" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const poll = messages.find(item => item.timestamp === Number(input.timestamp) && item.poll && item.direction === "out");
    if (!poll) return json(res, 404, { error: "Owned poll unavailable" }); const common = { account, pollTimestamp: poll.timestamp }; const params = input.kind === "group" ? { ...common, groupIds: [input.target] } : { ...common, recipients: [input.target] };
    await rpc("sendPollTerminate", params); poll.poll.closed = true; await persistMessages(); return json(res, 200, { message: poll });
  }
  if (url.pathname === "/api/view-once/open" && req.method === "POST") {
    const input = await body(req);
    const message = messages.find(item => item.id === String(input.messageId) && item.viewOnce && !item.viewOnceOpened);
    if (!message) return json(res, 404, { error: "View-once media is unavailable" });
    const token = randomBytes(24).toString("base64url");
    message.viewOnceOpened = true;
    viewOnceTokens.set(token, { messageId: message.id, expires: Date.now() + 5 * 60_000 });
    setTimeout(async () => {
      viewOnceTokens.delete(token);
      for (const attachment of message.attachments || []) {
        const path = attachment.localFile ? join(MEDIA_DIR, basename(String(attachment.id))) : join(SIGNAL_DIR, "attachments", basename(String(attachment.id)));
        await unlink(path).catch(() => {});
      }
      message.attachments = [];
      await persistMessages().catch(error => log("view-once cleanup failed", error.message));
    }, 5 * 60_000).unref();
    await persistMessages();
    return json(res, 200, { url: `/api/attachment/${encodeURIComponent(message.id)}/0?viewToken=${token}` });
  }
  if (url.pathname === "/api/voice" && req.method === "POST") {
    const account = await getAccount();
    const kind = url.searchParams.get("kind"); const target = url.searchParams.get("target");
    if (!target || !["direct", "group"].includes(kind)) return json(res, 400, { error: "Invalid conversation" });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 12 * 1024 * 1024) return json(res, 413, { error: "Voice note is too large" }); chunks.push(chunk); }
    if (!size) return json(res, 400, { error: "Recording is empty" });
    const contentType = String(req.headers["content-type"] || "audio/webm").split(";")[0];
    const extension = contentType.includes("ogg") ? ".ogg" : contentType.includes("mp4") ? ".m4a" : contentType.includes("mpeg") ? ".mp3" : contentType.includes("3gpp") ? ".3gp" : contentType.includes("amr") ? ".amr" : contentType.includes("wav") ? ".wav" : ".webm";
    const localName = `${Date.now()}-${randomBytes(5).toString("hex")}${extension}`;
    const path = join(MEDIA_DIR, localName); await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
    try {
      const common = { account, message: "", attachments: [path], voiceNote: true };
      const params = kind === "group" ? { ...common, groupId: target } : target === account ? { ...common, noteToSelf: true } : { ...common, recipient: [target] };
      const result = await rpc("send", params, 120_000); const timestamp = Number(result?.timestamp || Date.now());
      const sent = { id: `${timestamp}-out`, conversationId: `${kind}:${target}`, direction: "out", sender: account, senderId: account, text: "", timestamp, status: "sent", receipts: {}, reactions: [], attachments: [{ id: localName, localFile: true, filename: `voice-note${extension}`, contentType, size }], voiceNote: true };
      messages.push(sent); await persistMessages(); return json(res, 200, { message: sent });
    } catch (error) { await unlink(path).catch(() => {}); throw error; }
  }
  if (url.pathname === "/api/message/edit" && req.method === "POST") {
    const input = await body(req);
    const account = await getAccount();
    const targetTimestamp = Number(input.timestamp);
    const existing = messages.find(item => item.timestamp === targetTimestamp && item.direction === "out" && !item.deleted);
    if (!existing) return json(res, 404, { error: "Outgoing message not found" });
    const text = String(input.message || "").trim();
    if (!text || text.length > 4000) return json(res, 400, { error: "Message must be 1–4000 characters" });
    const params = input.kind === "group"
      ? { account, groupId: input.target, message: text, editTimestamp: targetTimestamp }
      : { account, recipient: [input.target], message: text, editTimestamp: targetTimestamp };
    await rpc("send", params);
    existing.text = text;
    existing.edited = true;
    await persistMessages();
    return json(res, 200, { message: existing });
  }
  if (url.pathname === "/api/message/delete" && req.method === "POST") {
    const input = await body(req);
    const account = await getAccount();
    const targetTimestamp = Number(input.timestamp);
    const existing = messages.find(item => item.timestamp === targetTimestamp && item.direction === "out" && !item.deleted);
    if (!existing) return json(res, 404, { error: "Outgoing message not found" });
    const params = input.kind === "group"
      ? { account, groupIds: [input.target], targetTimestamp }
      : { account, recipients: [input.target], targetTimestamp };
    await rpc("remoteDelete", params);
    existing.deleted = true;
    existing.text = "Message deleted";
    existing.attachments = [];
    await persistMessages();
    return json(res, 200, { message: existing });
  }
  if (url.pathname === "/api/attachment/send" && req.method === "POST") {
    const account = await getAccount(); const kind = url.searchParams.get("kind"); const target = url.searchParams.get("target");
    if (!account) return json(res, 409, { error: "Signal is not linked" });
    if (!target || !["direct", "group"].includes(kind)) return json(res, 400, { error: "Invalid conversation" });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 100 * 1024 * 1024) return json(res, 413, { error: "Attachment is too large" }); chunks.push(chunk); }
    if (!size) return json(res, 400, { error: "Attachment is empty" });
    const contentType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].replace(/[^\w.+/-]/g, "") || "application/octet-stream";
    const originalName = basename(String(url.searchParams.get("filename") || "attachment")).replace(/[\x00-\x1f\x7f"\\]/g, "_").slice(0, 180) || "attachment";
    const extension = extname(originalName).slice(0, 16).replace(/[^.\w-]/g, "");
    const localName = `${Date.now()}-${randomBytes(6).toString("hex")}${extension}`; const path = join(MEDIA_DIR, localName);
    await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
    try {
      const message = String(url.searchParams.get("caption") || "").trim().slice(0, 4000); const common = { account, message, attachments: [path] };
      const conversationId = `${kind}:${target}`; const expiration = Number(appState.expirations[conversationId] ?? appState.settings.defaultExpiration ?? 0);
      if (!(conversationId in appState.expirations) && expiration) { if (kind === "group") await rpc("updateGroup", { account, groupId: target, expiration }); else await rpc("updateContact", { account, recipient: target, expiration }); appState.expirations[conversationId] = expiration; await persistState(); }
      const params = kind === "group" ? { ...common, groupId: target } : target === account ? { ...common, noteToSelf: true } : { ...common, recipient: [target] };
      const result = await rpc("send", params, 180_000); const timestamp = Number(result?.timestamp || Date.now());
      const sent = { id: `${timestamp}-out`, conversationId, direction: "out", sender: account, senderId: account, text: message, timestamp, status: "sent", receipts: {}, reactions: [], attachments: [{ id: localName, localFile: true, filename: originalName, contentType, size }], expiresInSeconds: expiration, expiresAt: expiration ? timestamp + expiration * 1000 : null };
      messages.push(sent); await persistMessages(); return json(res, 200, { message: sent });
    } catch (error) { await unlink(path).catch(() => {}); throw error; }
  }
  if (url.pathname === "/api/message/forward" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const source = messages.find(item => item.id === String(input.messageId) && !item.deleted);
    if (!source) return json(res, 404, { error: "Message not found" });
    if (!input.target || !["direct", "group"].includes(input.kind)) return json(res, 400, { error: "Invalid destination" });
    const attachmentPaths = (source.attachments || []).map(attachment => attachment.localFile ? join(MEDIA_DIR, basename(String(attachment.id))) : join(SIGNAL_DIR, "attachments", basename(String(attachment.id)))).filter(path => existsSync(path));
    const common = source.sticker ? { account, message: "", sticker: `${source.sticker.packId}:${source.sticker.stickerId}` } : { account, message: source.text || "", ...(attachmentPaths.length ? { attachments: attachmentPaths } : {}) };
    if (!source.sticker && !common.message && !attachmentPaths.length) return json(res, 400, { error: "This message cannot be forwarded" });
    const params = input.kind === "group" ? { ...common, groupId: input.target } : input.target === account ? { ...common, noteToSelf: true } : { ...common, recipient: [input.target] };
    const result = await rpc("send", params, 180_000); const timestamp = Number(result?.timestamp || Date.now());
    const sent = {
      ...source,
      id: `${timestamp}-out`,
      conversationId: `${input.kind}:${input.target}`,
      direction: "out",
      sender: account,
      senderId: account,
      timestamp,
      status: "sent",
      receipts: {},
      reactions: [],
      quote: null,
      pinned: false,
      forwardedFrom: source.forwardedFrom || (source.direction === "out" ? "You" : source.sender || "Someone"),
    };
    messages.push(sent); await persistMessages(); return json(res, 200, { message: sent });
  }
  if (url.pathname === "/api/stickers" && req.method === "GET") {
    const account = await getAccount();
    const knownPacks = await rpc("listStickerPacks", { account }).catch(error => {
      log("list sticker packs failed", error.message);
      return [];
    });
    const unique = new Map();
    for (const pack of Array.isArray(knownPacks) ? knownPacks : knownPacks?.stickerPacks || knownPacks?.packs || []) {
      const packId = String(pack.packId || pack.id || pack.pack_id || "");
      if (!packId) continue;
      const title = String(pack.title || pack.name || "Sticker pack");
      const listed = Array.isArray(pack.stickers) ? pack.stickers : [];
      const local = await readdir(join(SIGNAL_DIR, "stickers", basename(packId))).catch(() => []);
      const entries = listed.length
        ? listed
        : local.map((name, index) => ({ stickerId: /^\d+$/.test(name) ? Number(name) : index }));
      for (const [index, sticker] of entries.entries()) {
        const stickerId = String(sticker.stickerId ?? sticker.id ?? sticker.index ?? index);
        const key = `${packId}:${stickerId}`;
        unique.set(key, {
          id: key,
          packId,
          stickerId,
          packTitle: title,
          emoji: sticker.emoji || "",
          path: `/api/sticker/${encodeURIComponent(packId)}/${encodeURIComponent(stickerId)}`,
        });
      }
    }
    for (const message of messages) {
      if (!message.sticker?.packId || message.sticker?.stickerId === undefined) continue;
      const key = `${message.sticker.packId}:${message.sticker.stickerId}`;
      if (unique.has(key)) continue;
      unique.set(key, {
        id: key,
        packId: message.sticker.packId,
        stickerId: String(message.sticker.stickerId),
        packTitle: "Recent stickers",
        emoji: message.sticker.emoji || "",
        path: `/api/sticker/${encodeURIComponent(message.sticker.packId)}/${encodeURIComponent(message.sticker.stickerId)}`,
      });
    }
    return json(res, 200, { stickers: [...unique.values()].slice(-120).reverse() });
  }
  if (url.pathname === "/api/sticker/send" && req.method === "POST") {
    const input = await body(req); const account = await getAccount(); const packId = basename(String(input.packId || "")); const stickerId = basename(String(input.stickerId || ""));
    if (!packId || !stickerId || !input.target || !["direct", "group"].includes(input.kind)) return json(res, 400, { error: "Invalid sticker" });
    const common = { account, message: "", sticker: `${packId}:${stickerId}` }; const params = input.kind === "group" ? { ...common, groupId: input.target } : input.target === account ? { ...common, noteToSelf: true } : { ...common, recipient: [input.target] };
    const result = await rpc("send", params); const timestamp = Number(result?.timestamp || Date.now()); const sent = { id: `${timestamp}-out`, conversationId: `${input.kind}:${input.target}`, direction: "out", sender: account, senderId: account, text: "", timestamp, status: "sent", receipts: {}, reactions: [], attachments: [], sticker: { packId, stickerId } };
    messages.push(sent); await persistMessages(); return json(res, 200, { message: sent });
  }
  if (url.pathname.startsWith("/api/attachment/") && req.method === "GET") {
    const parts = url.pathname.slice(16).split("/");
    const messageId = decodeURIComponent(parts[0] || "");
    const index = Number(parts[1]);
    const message = messages.find(item => item.id === messageId);
    const attachment = message?.attachments?.[index];
    if (!attachment?.id || !Number.isInteger(index)) return json(res, 404, { error: "Attachment not found" });
    if (message.viewOnce) {
      const token = url.searchParams.get("viewToken"); const grant = viewOnceTokens.get(token);
      if (!grant || grant.messageId !== message.id || grant.expires < Date.now()) return json(res, 403, { error: "View-once authorization expired" });
    }
    const path = attachment.localFile ? join(MEDIA_DIR, basename(String(attachment.id))) : join(SIGNAL_DIR, "attachments", basename(String(attachment.id)));
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return json(res, 404, { error: "Attachment file is unavailable" });
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    if (range) {
      start = range[1] ? Number(range[1]) : 0;
      end = range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end || start >= info.size) return json(res, 416, { error: "Invalid range" });
      status = 206;
    }
    const headers = {
      "content-type": attachment.contentType,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="${String(attachment.filename).replace(/["\r\n]/g, "_")}"`,
      "x-content-type-options": "nosniff",
    };
    if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
    res.writeHead(status, headers);
    return createReadStream(path, { start, end }).pipe(res);
  }
  if (url.pathname.startsWith("/api/sticker/") && req.method === "GET") {
    const parts = url.pathname.slice(13).split("/"); const packId = basename(decodeURIComponent(parts[0] || "")); const stickerId = basename(decodeURIComponent(parts[1] || ""));
    const path = join(SIGNAL_DIR, "stickers", packId, stickerId); const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      const account = await getAccount();
      const result = await rpc("getSticker", { account, packId, stickerId: Number(stickerId) }).catch(() => null);
      const encoded = typeof result === "string" ? result : result?.data || result?.base64;
      if (!encoded) return json(res, 404, { error: "Sticker unavailable" });
      const data = Buffer.from(encoded, "base64");
      res.writeHead(200, { "content-type": "image/webp", "content-length": data.length, "cache-control": "private, max-age=3600" });
      return res.end(data);
    }
    res.writeHead(200, { "content-type": "image/webp", "content-length": info.size, "cache-control": "private, max-age=3600" }); return createReadStream(path).pipe(res);
  }
  if (url.pathname.startsWith("/api/avatar/") && req.method === "GET") {
    const parts = url.pathname.slice(12).split("/");
    const kind = parts.shift();
    const target = decodeURIComponent(parts.join("/"));
    const prefix = kind === "group" ? "group-" : "profile-";
    const path = join(SIGNAL_DIR, "avatars", basename(`${prefix}${target}`));
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return json(res, 404, { error: "Avatar unavailable" });
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": info.size, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
    return createReadStream(path).pipe(res);
  }
  if (url.pathname === "/api/send" && req.method === "POST") {
    const input = await body(req);
    const account = await getAccount();
    if (!account) return json(res, 409, { error: "Signal is not linked" });
    const text = String(input.message || "").trim();
    if (!text || text.length > 4000) return json(res, 400, { error: "Message must be 1–4000 characters" });
    const conversationId = `${input.kind}:${input.target}`;
    const expiration = Number(appState.expirations[conversationId] ?? appState.settings.defaultExpiration ?? 0);
    if (!(conversationId in appState.expirations) && expiration) {
      if (input.kind === "group") await rpc("updateGroup", { account, groupId: input.target, expiration });
      else await rpc("updateContact", { account, recipient: input.target, expiration });
      appState.expirations[conversationId] = expiration;
      await persistState();
    }
    const quote = input.quoteTimestamp ? messages.find(item => item.timestamp === Number(input.quoteTimestamp)) : null;
    const common = {
      account,
      message: text,
      ...(quote ? { quoteTimestamp: quote.timestamp, quoteAuthor: quote.direction === "out" ? account : quote.senderId, quoteMessage: quote.text || "" } : {}),
    };
    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    let preview;
    if (urlMatch && appState.settings.linkPreviews) {
      common.previewUrl = urlMatch[0];
      try { common.previewTitle = new URL(urlMatch[0]).hostname; } catch { common.previewTitle = "Link"; }
      preview = { url: common.previewUrl, title: common.previewTitle };
    }
    const noteToSelf = input.kind === "direct" && input.target === account;
    const params = input.kind === "group"
      ? { ...common, groupId: input.target }
      : noteToSelf ? { ...common, noteToSelf: true } : { ...common, recipient: [input.target] };
    const result = await rpc("send", params);
    const timestamp = Number(result?.timestamp || Date.now());
    const sent = { id: `${timestamp}-out`, conversationId, direction: "out", sender: account, senderId: account, text, timestamp, status: "sent", receipts: {}, reactions: [], attachments: [], previews: preview ? [preview] : [], quote: quote ? { timestamp: quote.timestamp, author: quote.sender || quote.senderId, text: quote.text || "" } : null, expiresInSeconds: expiration, expiresAt: expiration ? timestamp + expiration * 1000 : null };
    if (!messages.some(item => item.id === sent.id)) {
      messages.push(sent);
      await persistMessages();
    }
    return json(res, 200, { message: sent });
  }
  return json(res, 404, { error: "Not found" });
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };
async function staticFile(req, res, url) {
  const relative = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^\/+/, "");
  const path = join(PUBLIC_DIR, relative);
  if (!path.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" });
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error();
    res.writeHead(200, {
      "content-type": mime[extname(path)] || "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-cache",
      "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    createReadStream(path).pipe(res);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/internal/wacli/webhook" && req.method === "POST") {
      return whatsapp.handleWebhook(req, res);
    }
    if (url.pathname === "/healthz") return json(res, signalReady ? 200 : 503, { ok: signalReady });
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "public, max-age=86400" });
      return res.end();
    }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    return await staticFile(req, res, url);
  } catch (error) {
    log("request failed", error.stack || error.message);
    if (!res.headersSent) json(res, 500, { error: error.message || "Internal error" });
    else res.end();
  }
});

startSignal();
server.listen(PORT, "0.0.0.0", () => log(`web UI listening on ${PORT}`));

function shutdown() {
  shuttingDown = true;
  signalReady = false;
  server.close();
  signalProcess?.kill("SIGTERM");
  void telegram.shutdown();
  void whatsapp.shutdown();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
