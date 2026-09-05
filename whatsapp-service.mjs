import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, extname, join, resolve } from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import QRCode from "qrcode";

const WACLI = "/usr/local/bin/wacli";
const DEFAULT_SETTINGS = {
  sendReadReceipts: true,
  sendTypingIndicators: true,
  linkPreviews: true,
  defaultExpiration: 0,
};
const MAX_STORED_RECEIPTS = 5_000;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function value(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object?.[key] !== null) return object[key];
  }
  return undefined;
}

function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function mediaKind(type, mime) {
  const source = `${type || ""} ${mime || ""}`.toLowerCase();
  if (source.includes("image") || source.includes("sticker")) return "image";
  if (source.includes("video")) return "video";
  if (source.includes("audio") || source.includes("voice") || source.includes("ptt")) return "audio";
  return "file";
}

function isGroup(jid, kind) {
  return kind === "group" || String(jid).endsWith("@g.us");
}

function safeJid(value) {
  const jid = String(value || "").trim();
  if (!/^[A-Za-z0-9._:@-]+$/.test(jid)) throw new Error("Invalid WhatsApp chat");
  return jid;
}

function safeMessageId(value) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._:@-]+$/.test(id)) throw new Error("Invalid WhatsApp message");
  return id;
}

function errorText(stderr, fallback = "WhatsApp request failed") {
  const text = String(stderr || "").trim();
  try {
    const parsed = JSON.parse(text);
    return parsed.error || parsed.message || fallback;
  } catch {
    return text || fallback;
  }
}

function webhookJid(value) {
  return typeof value === "string" ? value : value?.User && value?.Server ? `${value.User}@${value.Server}` : "";
}

function receiptState(type) {
  return type === "read" || type === "played" ? "read" : "delivered";
}

function isLaterReceiptState(next, current) {
  return next === "read" || current !== "read";
}

export class WhatsAppService {
  constructor({ dataDir, log }) {
    this.dataDir = join(dataDir, "whatsapp");
    this.mediaDir = join(this.dataDir, "media");
    this.statePath = join(this.dataDir, "state.json");
    this.log = log;
    this.authProcess = null;
    this.authMethod = null;
    this.syncProcess = null;
    this.qr = null;
    this.pairCode = null;
    this.lastError = null;
    this.accountLabel = null;
    this.state = { favourites: [], settings: { ...DEFAULT_SETTINGS }, receipts: {} };
    this.dialogCache = { at: 0, values: [] };
    this.messageCache = new Map();
    this.webhookSecret = randomBytes(32).toString("hex");
    this.receipts = new Map();
    this.receiptPersistTimer = null;
    this.typing = new Map();
  }

  get sessionPath() {
    return join(this.dataDir, "session.db");
  }

  async initialize() {
    await mkdir(this.mediaDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.statePath, "utf8"));
      this.state = {
        ...this.state,
        ...saved,
        settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
        receipts: saved.receipts && typeof saved.receipts === "object" ? saved.receipts : {},
      };
    } catch {}
    for (const [key, receipt] of Object.entries(this.state.receipts)) {
      if (!receipt || typeof receipt !== "object") continue;
      const state = receipt.state === "read" ? "read" : "delivered";
      this.receipts.set(key, {
        state,
        at: timestamp(receipt.at),
        recipients: receipt.recipients && typeof receipt.recipients === "object" ? receipt.recipients : {},
      });
    }
    this.trimReceipts();
    await this.refreshStatus();
    if (this.isLinked()) this.startSync();
  }

  async persistState() {
    await writeFile(this.statePath, JSON.stringify(this.state), { mode: 0o600 });
  }

  trimReceipts() {
    if (this.receipts.size <= MAX_STORED_RECEIPTS) return;
    const oldest = [...this.receipts.entries()]
      .sort(([, left], [, right]) => (left.at || 0) - (right.at || 0))
      .slice(0, this.receipts.size - MAX_STORED_RECEIPTS);
    for (const [key] of oldest) this.receipts.delete(key);
  }

  scheduleReceiptPersist() {
    if (this.receiptPersistTimer) return;
    this.receiptPersistTimer = setTimeout(() => {
      this.receiptPersistTimer = null;
      this.state.receipts = Object.fromEntries(this.receipts);
      this.persistState().catch(error => this.log("persist WhatsApp receipts", error.message));
    }, 250);
  }

  isLinked() {
    return Boolean(this.accountLabel);
  }

  async refreshStatus() {
    if (!existsSync(this.sessionPath)) {
      this.accountLabel = null;
      return false;
    }
    try {
      const result = await this.run(["--read-only", "auth", "status"]);
      if (result.authenticated) {
        // The session is already valid when WhatsApp acknowledges the pairing.
        // A linked JID can arrive a fraction later, so retain a neutral label
        // rather than leaving the setup screen stuck at "Waiting".
        this.accountLabel = result.linked_jid || result.phone || this.accountLabel || "WhatsApp";
      } else {
        this.accountLabel = null;
      }
    } catch (error) {
      // A newly-created SQLite store can briefly be unavailable while wacli
      // writes its paired-device record. Do not discard a confirmed link for a
      // transient read failure.
      if (!this.accountLabel) this.log("wacli auth status", error.message);
    }
    return this.isLinked();
  }

  statusPayload() {
    return {
      ready: true,
      connected: this.isLinked(),
      authStage: this.isLinked() ? "authorized" : this.authProcess ? "qr" : "qr",
      accountLabel: this.accountLabel || undefined,
      qr: this.qr,
      pairCode: this.pairCode,
      error: this.lastError || undefined,
    };
  }

  command(args, { stdin = null } = {}) {
    return spawn(WACLI, ["--store", this.dataDir, "--json", ...args], {
      env: { ...process.env, WACLI_STORE_DIR: this.dataDir },
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
  }

  run(args, options = {}) {
    return new Promise((resolvePromise, reject) => {
      const process = this.command(args, options);
      let stdout = "";
      let stderr = "";
      process.stdout.on("data", chunk => { stdout += chunk; });
      process.stderr.on("data", chunk => { stderr += chunk; });
      process.on("error", reject);
      process.on("exit", code => {
        if (code !== 0) return reject(new Error(errorText(stderr)));
        try {
          const parsed = stdout.trim() ? JSON.parse(stdout) : {};
          if (typeof parsed?.success === "boolean") {
            if (!parsed.success) return reject(new Error(parsed.error || "WhatsApp request failed"));
            return resolvePromise(parsed.data ?? {});
          }
          resolvePromise(parsed);
        } catch {
          reject(new Error("WhatsApp returned invalid JSON"));
        }
      });
      if (options.stdin) process.stdin.end(options.stdin);
    });
  }

  runWrite(args) {
    return this.run(["--lock-wait", "20s", ...args]);
  }

  // wacli's sync daemon exposes a send socket. Do not wait on its store lock:
  // an immediate lock result makes wacli delegate the send to that live daemon.
  runSend(args) {
    return this.run(args);
  }

  async beginSetup(phone = "") {
    if (this.isLinked()) return this.statusPayload();
    const normalizedPhone = String(phone).replace(/[\s().-]/g, "");
    if (normalizedPhone && !/^\+?[1-9]\d{6,14}$/.test(normalizedPhone)) {
      throw new Error("Enter your full phone number, including country code");
    }
    const authMethod = normalizedPhone ? "phone" : "qr";
    if (this.authProcess && this.authMethod === authMethod) return this.statusPayload();
    if (this.authProcess) await this.stopAuth();

    this.lastError = null;
    this.qr = null;
    this.pairCode = null;
    this.authMethod = authMethod;
    // --events belongs to the auth command. It makes QR and phone-pair codes
    // machine-readable on stderr while retaining wacli's normal auth flow.
    const authArgs = ["--store", this.dataDir, "auth", "--events", "--download-media"];
    if (normalizedPhone) authArgs.push("--phone", normalizedPhone);
    else authArgs.push("--qr-format", "text");

    const child = spawn(WACLI, authArgs, {
      env: { ...process.env, WACLI_STORE_DIR: this.dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.authProcess = child;
    let output = "";
    const consume = async chunk => {
      output += chunk.toString();
      const lines = output.split(/\r?\n/);
      output = lines.pop() || "";
      for (const line of lines) {
        const candidate = line.trim();
        if (!candidate) continue;
        let code = candidate;
        try {
          const event = JSON.parse(candidate);
          if (event?.event === "pair_code") {
            const pairCode = String(event?.data?.code || "").trim();
            if (pairCode) this.pairCode = { code: pairCode, phone: String(event?.data?.phone || normalizedPhone) };
            continue;
          }
          code = event?.data?.code || event?.code || "";
        } catch {}
        if (!code || code === this.qr?.url) continue;
        this.qr = { url: code, image: await QRCode.toDataURL(code, { errorCorrectionLevel: "L", margin: 1, width: 512 }) };
      }
    };
    child.stdout.on("data", chunk => void consume(chunk));
    child.stderr.on("data", chunk => {
      void consume(chunk);
      const text = chunk.toString().trim();
      if (text) this.log("wacli auth", text);
    });
    child.on("exit", async code => {
      if (this.authProcess !== child) return;
      this.authProcess = null;
      this.authMethod = null;
      await this.refreshStatus();
      if (code && !this.isLinked()) this.lastError = "WhatsApp linking did not complete";
      if (this.isLinked()) this.startSync();
    });
    for (let attempt = 0; attempt < 60 && !this.qr && !this.pairCode && this.authProcess === child; attempt++) await delay(100);
    if (!this.qr && !this.pairCode) throw new Error(this.lastError || "WhatsApp did not provide a linking code");
    return this.statusPayload();
  }

  async stopAuth() {
    const child = this.authProcess;
    if (!child) return;
    this.authProcess = null;
    this.authMethod = null;
    this.qr = null;
    this.pairCode = null;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(2_000)]);
  }

  async pollSetup() {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && this.authProcess && !this.isLinked()) {
      await this.refreshStatus();
      if (this.isLinked()) break;
      await delay(500);
    }
    await this.refreshStatus();
    return this.statusPayload();
  }

  startSync() {
    if (this.syncProcess || !this.isLinked()) return;
    const child = spawn(WACLI, ["--store", this.dataDir, "--events", "sync", "--follow", "--download-media", "--presence-mode", "quiet", "--webhook", "http://127.0.0.1:8080/internal/wacli/webhook", "--webhook-secret", this.webhookSecret, "--webhook-allow-private", "--webhook-events", "message,receipt,chat_presence", "--max-messages", process.env.WACLI_SYNC_MAX_MESSAGES || "50000", "--max-db-size", process.env.WACLI_SYNC_MAX_DB_SIZE || "1GB"], {
      env: { ...process.env, WACLI_STORE_DIR: this.dataDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.syncProcess = child;
    child.stderr.on("data", chunk => {
      const text = chunk.toString().trim();
      if (text) this.log("wacli sync", text);
      this.dialogCache.at = 0;
      this.messageCache.clear();
    });
    child.on("exit", code => {
      if (this.syncProcess !== child) return;
      this.syncProcess = null;
      if (code && this.isLinked()) setTimeout(() => this.startSync(), 5_000).unref();
    });
  }

  async disconnect() {
    this.authProcess?.kill("SIGTERM");
    this.syncProcess?.kill("SIGTERM");
    this.authProcess = null;
    this.authMethod = null;
    this.syncProcess = null;
    if (this.isLinked()) await this.run(["auth", "logout"]).catch(error => this.log("wacli logout", error.message));
    await rm(this.dataDir, { recursive: true, force: true });
    await mkdir(this.mediaDir, { recursive: true });
    this.accountLabel = null;
    this.qr = null;
    this.pairCode = null;
    this.dialogCache = { at: 0, values: [] };
    this.messageCache.clear();
  }

  async allChats() {
    if (this.dialogCache.at && Date.now() - this.dialogCache.at < 15_000) {
      return this.dialogCache.values;
    }
    const values = asArray(await this.run(["chats", "list", "--limit", "300"]));
    this.dialogCache = { at: Date.now(), values };
    return values;
  }

  normalizeMessage(message, chatJid, chatName = "") {
    const id = String(value(message, "msg_id", "MsgID", "id") || "");
    const mediaType = String(value(message, "media_type", "MediaType") || "");
    const mimeType = String(value(message, "mime_type", "MimeType") || "");
    const localPath = value(message, "local_path", "LocalPath");
    const text = String(value(message, "text", "Text", "display_text", "DisplayText", "media_caption", "MediaCaption") || "");
    const result = {
      id,
      conversationId: chatJid,
      direction: value(message, "from_me", "FromMe") ? "out" : "in",
      sender: String(value(message, "sender_name", "SenderName") || "WhatsApp user"),
      senderId: String(value(message, "sender_jid", "SenderJID") || ""),
      text,
      timestamp: timestamp(value(message, "timestamp", "Timestamp")),
      edited: Boolean(value(message, "edited", "Edited")),
      deleted: Boolean(value(message, "revoked", "Revoked", "deleted_for_me", "DeletedForMe")),
      forwardedFrom: value(message, "is_forwarded", "IsForwarded") ? "Forwarded" : undefined,
      quote: value(message, "quoted_msg_id", "QuotedMsgID")
        ? { id: String(value(message, "quoted_msg_id", "QuotedMsgID")), author: String(value(message, "quoted_sender_jid", "QuotedSenderJID") || "Reply"), text: "Quoted message" }
        : undefined,
      attachments: mediaType || localPath ? [{
        id: "0",
        contentType: mimeType || undefined,
        filename: value(message, "filename", "Filename") || undefined,
        size: 0,
        kind: mediaKind(mediaType, mimeType),
        localPath: localPath || undefined,
      }] : [],
      reactions: [],
      poll: undefined,
      status: this.receipts.get(`${chatJid}:${id}`)?.state || "sent",
      receipt: this.receipts.get(`${chatJid}:${id}`),
    };
    this.messageCache.set(`${chatJid}:${id}`, { ...result, chatName });
    return result;
  }

  async conversations(archived) {
    const chats = (await this.allChats()).filter(chat => Boolean(value(chat, "archived", "Archived")) === archived);
    const conversations = [];
    for (const chat of chats) {
      const jid = String(value(chat, "jid", "JID") || "");
      if (!jid) continue;
      const name = String(value(chat, "name", "Name") || jid);
      let last;
      try {
        const page = await this.run(["messages", "list", "--chat", jid, "--limit", "1"]);
        const rows = asArray(page.messages || page);
        if (rows[0]) last = this.normalizeMessage(rows[0], jid, name);
      } catch {}
      conversations.push({
        id: jid,
        kind: isGroup(jid, value(chat, "kind", "Kind")) ? "group" : "direct",
        target: jid,
        name,
        archived: Boolean(value(chat, "archived", "Archived")),
        favorite: this.state.favourites.includes(jid) || Boolean(value(chat, "pinned", "Pinned")),
        muted: Number(value(chat, "muted_until", "MutedUntil") || 0) === -1 || Number(value(chat, "muted_until", "MutedUntil") || 0) > Date.now() / 1000,
        unread: Number(value(chat, "unread_count", "UnreadCount") || 0),
        last,
        typing: [],
        expiration: 0,
        members: [],
        admins: [],
        permissions: {},
      });
    }
    return conversations;
  }

  async messages(jid, before) {
    const args = ["messages", "list", "--chat", safeJid(jid), "--limit", "60", "--asc"];
    if (before) args.push("--before", new Date(Number(before)).toISOString());
    const page = await this.run(args);
    const rows = asArray(page.messages || page);
    const reactions = rows.filter(row => value(row, "reaction_to_id", "ReactionToID"));
    const messages = rows
      .filter(row => !value(row, "reaction_to_id", "ReactionToID"))
      .map(row => this.normalizeMessage(row, jid));
    const byId = new Map(messages.map(message => [message.id, message]));
    for (const reaction of reactions) {
      const target = byId.get(String(value(reaction, "reaction_to_id", "ReactionToID")));
      const emoji = String(value(reaction, "reaction_emoji", "ReactionEmoji") || "");
      if (!target || !emoji) continue;
      target.reactions.push({
        emoji,
        author: String(value(reaction, "sender_name", "SenderName") || "WhatsApp user"),
        own: Boolean(value(reaction, "from_me", "FromMe")),
      });
    }
    const polls = await this.run(["polls", "list", "--chat", safeJid(jid), "--limit", "100"])
      .catch(() => ({ polls: [] }));
    for (const poll of asArray(polls.polls)) {
      const target = byId.get(String(value(poll, "msg_id", "MsgID")));
      if (!target) continue;
      target.poll = {
        question: String(value(poll, "question", "Question") || "Poll"),
        options: asArray(value(poll, "options", "Options")).map((text, index) => ({
          index,
          text: String(text),
          votes: [],
        })),
        multiple: Number(value(poll, "selectable_count", "SelectableCount") || 1) > 1,
        closed: false,
      };
    }
    const typing = this.typing.get(jid);
    return { messages, hasMore: rows.length === 60, readThrough: 0, typing: typing?.until > Date.now() ? typing.names : [] };
  }

  cachedMessage(jid, id) {
    return this.messageCache.get(`${jid}:${id}`);
  }

  async sendText(input) {
    const target = safeJid(input.target);
    const text = String(input.message || "").trim();
    if (!text || text.length > 4000) throw new Error("Message must be 1–4000 characters");
    const args = ["send", "text", "--to", target, "--message", text];
    if (input.replyToId) args.push("--reply-to", safeMessageId(input.replyToId));
    if (input.replyToSender) args.push("--reply-to-sender", safeJid(input.replyToSender));
    const result = await this.runSend(args);
    this.dialogCache.at = 0;
    return {
      id: String(result.id || randomUUID()),
      conversationId: target,
      direction: "out",
      sender: "You",
      text,
      timestamp: Date.now(),
      attachments: [],
      reactions: [],
      status: "sent",
    };
  }

  async sendReaction(input) {
    const target = safeJid(input.target);
    const message = this.cachedMessage(target, safeMessageId(input.messageId));
    const args = ["send", "react", "--to", target, "--id", safeMessageId(input.messageId), "--reaction", input.remove ? "" : String(input.emoji || "")];
    if (isGroup(target) && message?.senderId) args.push("--sender", safeJid(message.senderId));
    await this.runSend(args);
  }

  async updateConversation(input) {
    const jid = safeJid(input.conversationId);
    if (typeof input.archived === "boolean") await this.runWrite(["chats", input.archived ? "archive" : "unarchive", "--chat", jid]);
    if (typeof input.muted === "boolean") await this.runWrite(["chats", input.muted ? "mute" : "unmute", "--chat", jid]);
    if (typeof input.favourite === "boolean") {
      await this.runWrite(["chats", input.favourite ? "pin" : "unpin", "--chat", jid]);
      this.state.favourites = input.favourite
        ? [...new Set([...this.state.favourites, jid])]
        : this.state.favourites.filter(item => item !== jid);
      await this.persistState();
    }
    this.dialogCache.at = 0;
  }

  async setTyping(input) {
    const target = safeJid(input.conversationId || input.target);
    await this.runWrite(["presence", input.active === false ? "paused" : "typing", "--to", target]);
  }

  async editMessage(input) {
    const target = safeJid(input.target);
    const message = String(input.message || "").trim();
    if (!message) throw new Error("Message cannot be empty");
    await this.runWrite(["messages", "edit", "--chat", target, "--id", safeMessageId(input.messageId), "--message", message]);
    this.messageCache.clear();
  }

  async deleteMessage(input) {
    await this.runWrite(["messages", "delete", "--chat", safeJid(input.target), "--id", safeMessageId(input.messageId)]);
    this.messageCache.clear();
  }

  async forwardMessage(input) {
    await this.runWrite([
      "messages", "forward",
      "--chat", safeJid(input.fromTarget),
      "--id", safeMessageId(input.messageId),
      "--to", safeJid(input.target),
    ]);
    this.dialogCache.at = 0;
  }

  async createPoll(input) {
    const options = asArray(input.options).map(option => String(option).trim()).filter(Boolean);
    if (options.length < 2) throw new Error("A poll needs at least two options");
    const args = [
      "send", "poll",
      "--to", safeJid(input.target),
      "--question", String(input.question || "").trim(),
      "--multi", String(input.multiple ? options.length : 1),
    ];
    for (const option of options) args.push("--option", option);
    await this.runWrite(args);
  }

  async votePoll(input) {
    const target = safeJid(input.target);
    const cached = this.cachedMessage(target, safeMessageId(input.messageId));
    const selected = asArray(input.options)
      .map(index => cached?.poll?.options?.[Number(index)]?.text)
      .filter(Boolean);
    if (!selected.length) throw new Error("Select at least one poll option");
    const args = ["poll", "vote", "--to", target, "--id", safeMessageId(input.messageId)];
    for (const option of selected) args.push("--option", option);
    await this.runWrite(args);
  }

  async createGroup(input) {
    const args = ["groups", "create", "--name", String(input.name || "").trim()];
    for (const member of asArray(input.members)) args.push("--user", safeJid(member));
    await this.runWrite(args);
    this.dialogCache.at = 0;
  }

  async updateGroup(input) {
    const target = safeJid(input.target);
    if (typeof input.name === "string" && input.name.trim()) {
      await this.runWrite(["groups", "rename", "--jid", target, "--name", input.name.trim()]);
    }
    if (typeof input.description === "string") {
      await this.runWrite(["groups", "topic", "--jid", target, "--text", input.description]);
    }
    if (Array.isArray(input.addMembers) && input.addMembers.length) {
      const args = ["groups", "participants", "add", "--jid", target];
      for (const member of input.addMembers) args.push("--user", safeJid(member));
      await this.runWrite(args);
    }
    if (Array.isArray(input.removeMembers) && input.removeMembers.length) {
      const args = ["groups", "participants", "remove", "--jid", target];
      for (const member of input.removeMembers) args.push("--user", safeJid(member));
      await this.runWrite(args);
    }
    this.dialogCache.at = 0;
  }

  async leaveGroup(input) {
    await this.runWrite(["groups", "leave", "--jid", safeJid(input.target)]);
    this.dialogCache.at = 0;
  }

  async sendAttachment(req, res, url) {
    const target = safeJid(url.searchParams.get("target"));
    const filename = basename(url.searchParams.get("filename") || "attachment");
    const caption = String(url.searchParams.get("caption") || "");
    const tempPath = join(this.mediaDir, `upload-${randomUUID()}-${filename}`);
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    await writeFile(tempPath, Buffer.concat(parts), { mode: 0o600 });
    try {
      await this.runSend(["send", "file", "--to", target, "--file", tempPath, "--filename", filename, "--caption", caption]);
      this.dialogCache.at = 0;
      return this.json(res, 200, { sent: true });
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  async serveAttachment(res, jid, messageId) {
    const cached = this.cachedMessage(safeJid(jid), safeMessageId(messageId));
    let path = cached?.attachments?.[0]?.localPath;
    if (!path || !(await stat(path).catch(() => null))?.isFile()) {
      await this.runWrite(["media", "download", "--chat", safeJid(jid), "--id", safeMessageId(messageId)]);
      const refreshed = await this.messages(jid);
      path = refreshed.messages.find(message => message.id === messageId)?.attachments?.[0]?.localPath;
    }
    const info = path && await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error("WhatsApp media is unavailable");
    const type = cached?.attachments?.[0]?.contentType || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-length": info.size, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
    createReadStream(path).pipe(res);
  }

  json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  }

  async handleWebhook(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const expected = createHmac("sha256", this.webhookSecret).update(raw).digest("hex");
    const provided = String(req.headers["x-wacli-signature"] || "");
    if (provided.length !== expected.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      return this.json(res, 401, { error: "Unauthorized" });
    }
    const event = JSON.parse(raw.toString("utf8"));
    if (event.EventType === "chat_presence" && event.State === "composing") {
      const chat = webhookJid(event.Chat);
      const sender = webhookJid(event.Sender) || "Someone";
      this.typing.set(chat, { names: [sender], until: Date.now() + 8_000 });
    }
    if (event.EventType === "receipt") {
      const chat = webhookJid(event.Chat);
      const sender = webhookJid(event.Sender);
      const state = receiptState(event.Type);
      const at = timestamp(event.Timestamp);
      for (const id of asArray(event.MessageIDs)) {
        const key = `${chat}:${id}`;
        const previous = this.receipts.get(key);
        const recipient = previous?.recipients?.[sender];
        const recipients = {
          ...(previous?.recipients || {}),
          ...(sender && isLaterReceiptState(state, recipient?.state)
            ? { [sender]: { state, at } }
            : {}),
        };
        this.receipts.set(key, {
          state: isLaterReceiptState(state, previous?.state) ? state : previous.state,
          at: Math.max(at, previous?.at || 0),
          recipients,
        });
      }
      this.trimReceipts();
      this.scheduleReceiptPersist();
    }
    this.dialogCache.at = 0;
    return this.json(res, 204, {});
  }

  async handle(req, res, url, { body, json }) {
    const root = "/api/services/whatsapp";
    const pathname = url.pathname.slice(root.length) || "/";
    if (pathname === "/status" && req.method === "GET") return json(res, 200, this.statusPayload());
    if (pathname === "/auth/qr/start" && req.method === "POST") return json(res, 200, await this.beginSetup());
    if (pathname === "/auth/phone/start" && req.method === "POST") return json(res, 200, await this.beginSetup((await body(req)).phone));
    if (pathname === "/auth/qr/poll" && req.method === "GET") return json(res, 200, await this.pollSetup());
    if (pathname === "/disconnect" && req.method === "POST") { await this.disconnect(); return json(res, 200, { disconnected: true }); }
    if (!this.isLinked()) return json(res, 409, { error: "WhatsApp is not linked" });
    if (pathname === "/conversations" && req.method === "GET") {
      const archived = url.searchParams.get("archived") === "1";
      const all = await this.allChats();
      return json(res, 200, { conversations: await this.conversations(archived), archivedCount: all.filter(chat => Boolean(value(chat, "archived", "Archived"))).length });
    }
    if (pathname.startsWith("/messages/") && req.method === "GET") return json(res, 200, await this.messages(decodeURIComponent(pathname.slice(10)), url.searchParams.get("before")));
    if (pathname === "/read" && req.method === "POST") {
      const input = await body(req);
      await this.run(["--lock-wait", "20s", "chats", "mark-read", "--chat", safeJid(input.conversationId)]);
      this.dialogCache.at = 0;
      return json(res, 200, { ok: true });
    }
    if (pathname === "/typing" && req.method === "POST") { await this.setTyping(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/send" && req.method === "POST") return json(res, 200, { message: await this.sendText(await body(req)) });
    if (pathname === "/reaction" && req.method === "POST") { await this.sendReaction(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/edit" && req.method === "POST") { await this.editMessage(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/delete" && req.method === "POST") { await this.deleteMessage(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/forward" && req.method === "POST") { await this.forwardMessage(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/poll/create" && req.method === "POST") { await this.createPoll(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/poll/vote" && req.method === "POST") { await this.votePoll(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/group/create" && req.method === "POST") { await this.createGroup(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/group/update" && req.method === "POST") { await this.updateGroup(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/group/leave" && req.method === "POST") { await this.leaveGroup(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/conversation" && req.method === "POST") { await this.updateConversation(await body(req)); return json(res, 200, { ok: true }); }
    if (pathname === "/settings" && req.method === "GET") return json(res, 200, { settings: this.state.settings });
    if (pathname === "/settings" && req.method === "POST") { this.state.settings = { ...this.state.settings, ...(await body(req)) }; await this.persistState(); return json(res, 200, { settings: this.state.settings }); }
    if (pathname.startsWith("/search") && req.method === "GET") {
      const query = url.searchParams.get("q") || "";
      const result = await this.run(["messages", "search", query, "--limit", "50"]);
      const rows = asArray(result.messages || result);
      return json(res, 200, { results: rows.map(row => ({ conversationId: value(row, "chat_jid", "ChatJID"), timestamp: timestamp(value(row, "timestamp", "Timestamp")), sender: value(row, "sender_name", "SenderName") || "WhatsApp user", text: value(row, "text", "Text", "display_text", "DisplayText") || "" })) });
    }
    if (pathname === "/attachment/send" && req.method === "POST") return this.sendAttachment(req, res, url);
    if (pathname.startsWith("/attachment/") && req.method === "GET") {
      const [, , jid, messageId] = pathname.split("/");
      return this.serveAttachment(res, decodeURIComponent(jid), decodeURIComponent(messageId));
    }
    return json(res, 404, { error: "Not found" });
  }

  async shutdown() {
    this.authProcess?.kill("SIGTERM");
    this.syncProcess?.kill("SIGTERM");
  }
}
