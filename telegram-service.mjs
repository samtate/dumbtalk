import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { TelegramClient } from "@mtcute/node";

const DEFAULT_SETTINGS = {
  sendReadReceipts: true,
  sendTypingIndicators: true,
  linkPreviews: true,
  defaultExpiration: 0,
};

const FALLBACK_REACTIONS = ["👍", "👎", "❤️", "🔥", "🥰", "👏"];
const DIALOG_CACHE_MS = 60_000;
const HISTORY_CACHE_MS = 30_000;
const PAGED_HISTORY_CACHE_MS = 60 * 60_000;
const ALLOWED_REACTIONS_CACHE_MS = 10 * 60_000;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function peerId(peer) {
  return Number(
    peer?.id ??
      peer?.markedId ??
      peer?.inputPeer?.userId ??
      peer?.inputPeer?.chatId ??
      peer?.inputPeer?.channelId,
  );
}

function peerName(peer, fallback = "Unknown") {
  return (
    peer?.displayName ||
    peer?.title ||
    [peer?.firstName, peer?.lastName].filter(Boolean).join(" ") ||
    peer?.username ||
    (peerId(peer) ? String(peerId(peer)) : fallback)
  );
}

function conversationKind(peer) {
  return peer?.type === "chat" ||
    ["group", "supergroup", "channel", "gigagroup"].includes(peer?.chatType || peer?.type)
    ? "group"
    : "direct";
}

function conversationId(peer) {
  return `${conversationKind(peer)}:${peerId(peer)}`;
}

function normalizeReaction(value) {
  return String(value || "").replace(/^❤$/, "❤️");
}

function mediaContentType(media) {
  if (!media) return "application/octet-stream";
  if (media.type === "photo") return "image/jpeg";
  if (["video", "animation", "video_note"].includes(media.type)) {
    return media.mimeType || "video/mp4";
  }
  if (["voice", "audio"].includes(media.type)) return media.mimeType || "audio/ogg";
  if (media.type === "sticker") {
    if (media.isAnimated) return "application/x-tgsticker";
    return media.isVideo ? "video/webm" : "image/webp";
  }
  return media.mimeType || "application/octet-stream";
}

function linkPreviews(message, enabled) {
  if (!enabled) return [];

  const page = message.media?.type === "web_page" ? message.media : message.webPage;
  const url = page?.url || page?.displayUrl || message.text?.match(/https?:\/\/[^\s]+/i)?.[0];
  if (!url) return [];

  let fallbackTitle = "Link";
  try {
    fallbackTitle = new URL(url).hostname;
  } catch {}

  return [{
    url,
    title: page?.title || page?.siteName || fallbackTitle,
    description: page?.description,
  }];
}

function serviceMessageText(message) {
  const action = message.action;
  return action?.message || action?.type?.replaceAll("_", " ") || "Chat updated";
}

function forwardedName(message) {
  const forward = message.forward;
  return forward?.fromName || peerName(forward?.from, "Telegram");
}

function pollFromMessage(message) {
  if (message.media?.type !== "poll") return null;
  return {
    question: message.media.question || "Poll",
    multiple: Boolean(message.media.isMultiple),
    closed: Boolean(message.media.isClosed),
    options: (message.media.answers || []).map((answer, index) => ({
      index,
      text: answer.text,
      votes: Array(Number(answer.voters || 0)).fill("Telegram user"),
      chosen: Boolean(answer.chosen),
    })),
  };
}

function errorCode(error) {
  return String(
    error?.errorMessage ||
      error?.text ||
      error?.message ||
      error?.code ||
      "Telegram request failed",
  );
}

function floodWaitSeconds(error) {
  const explicit = Number(error?.seconds);
  if (Number.isFinite(explicit) && explicit > 0) return Math.ceil(explicit);

  const match = errorCode(error).match(/(?:FLOOD|SLOWMODE)(?:_[A-Z]+)*_WAIT_(\d+)/i);
  return match ? Math.max(1, Number(match[1])) : error?.code === 420 ? 60 : 0;
}

function inputTarget(value) {
  const text = String(value ?? "").trim();
  if (/^-?\d+$/.test(text)) {
    const number = Number(text);
    if (Number.isSafeInteger(number)) return number;
  }
  if (text) return text;
  throw new Error("Invalid Telegram chat");
}

export class TelegramService {
  constructor({ dataDir, apiId, apiHash, log }) {
    this.dataDir = join(dataDir, "telegram");
    this.mediaDir = join(this.dataDir, "media");
    this.statePath = join(this.dataDir, "state.json");
    this.configPath = join(this.dataDir, "config.json");
    this.apiId = Number(apiId);
    this.apiHash = apiHash;
    this.log = log;
    this.configured = Number.isSafeInteger(this.apiId) && this.apiId > 0 && Boolean(apiHash);
    this.client = null;
    this.me = null;
    this.auth = { stage: "phone", phone: "", phoneCodeHash: "", hint: "" };
    this.qr = null;
    this.qrTask = null;
    this.qrAbort = null;
    this.qrPassword = null;
    this.messageCache = new Map();
    this.dialogCache = { at: 0, values: [], loaded: false };
    this.dialogRefresh = null;
    this.historyCache = new Map();
    this.historyRefreshes = new Map();
    this.allowedReactionCache = new Map();
    this.floodUntil = 0;
    this.reactionCache = { at: 0, values: [] };
    this.typing = new Map();
    this.mediaDownloads = new Map();
    this.avatarSources = new Map();
    this.avatarDownloads = new Map();
    this.detailCache = new Map();
    this.state = { favourites: [], settings: { ...DEFAULT_SETTINGS } };
  }

  async initialize() {
    if (!this.configured) {
      try {
        const config = JSON.parse(await readFile(this.configPath, "utf8"));
        this.apiId = Number(config.apiId);
        this.apiHash = config.apiHash;
        this.configured = Number.isSafeInteger(this.apiId) && this.apiId > 0 && Boolean(this.apiHash);
      } catch {}
    }
    if (!this.configured) return;

    await mkdir(this.mediaDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.statePath, "utf8"));
      this.state = {
        ...this.state,
        ...saved,
        settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
      };
    } catch {}

    this.client = new TelegramClient({
      apiId: this.apiId,
      apiHash: this.apiHash,
      storage: join(this.dataDir, "session.sqlite"),
    });
    this.bindUpdates();
    await this.refreshAuthorization();
  }

  async configure(apiId, apiHash) {
    const parsedId = Number(apiId);
    const parsedHash = String(apiHash || "").trim();
    if (!Number.isSafeInteger(parsedId) || parsedId <= 0) throw new Error("Enter a valid Telegram API ID");
    if (!/^[a-f0-9]{32}$/i.test(parsedHash)) throw new Error("Enter the 32-character Telegram API hash");
    if (this.client) throw new Error("Telegram is already configured");

    await mkdir(this.dataDir, { recursive: true });
    const temporary = `${this.configPath}.tmp`;
    await writeFile(temporary, JSON.stringify({ apiId: parsedId, apiHash: parsedHash }), { mode: 0o600 });
    await rename(temporary, this.configPath);
    this.apiId = parsedId;
    this.apiHash = parsedHash;
    this.configured = true;
    await this.initialize();
    return this.statusPayload();
  }

  bindUpdates() {
    this.client.onNewMessage.add(message => {
      const dialog = this.cachedConversation(peerId(message.chat));
      if (!dialog) {
        this.invalidateMessageViews();
        return;
      }
      const normalized = this.normalizeMessage(message, dialog);
      dialog.last = normalized;
      if (normalized.direction === "in") dialog.unread += 1;
      this.dialogCache.at = Date.now();
      this.historyCache.clear();
    });
    this.client.onEditMessage.add(message => {
      const dialog = this.cachedConversation(peerId(message.chat));
      if (dialog?.last?.telegramId === message.id) {
        dialog.last = this.normalizeMessage(message, dialog);
      }
      this.historyCache.clear();
    });
    this.client.onDeleteMessage.add(() => this.invalidateMessageViews());
    this.client.onHistoryRead.add(update => {
      const dialog = this.cachedConversation(update.chatId);
      if (dialog && !update.isDiscussion) {
        if (update.isOutbox) dialog.readOutboxMaxId = update.maxReadId;
        else {
          dialog.readInboxMaxId = update.maxReadId;
          dialog.unread = update.unreadCount;
        }
      }
      this.historyCache.clear();
    });
    this.client.onUserTyping.add(async event => {
      const id = Number(event.chatId);
      if (!id) return;
      if (event.status === "cancel") {
        this.typing.delete(id);
        return;
      }
      const user = await this.client.getPeer(event.userId).catch(() => null);
      this.typing.set(id, {
        name: peerName(user, "Someone"),
        until: Date.now() + 7_000,
      });
    });
  }

  invalidateMessageViews() {
    this.dialogCache.at = 0;
    this.historyCache.clear();
  }

  async refreshAuthorization() {
    if (!this.client) return false;
    try {
      this.me = await this.client.getMe();
      this.auth.stage = "authorized";
      return true;
    } catch {
      this.me = null;
      if (this.auth.stage === "authorized") this.auth.stage = "phone";
      return false;
    }
  }

  async persistState() {
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temporary, this.statePath);
  }

  requireConfigured() {
    if (!this.configured) {
      throw new Error("Telegram API credentials are not configured");
    }
  }

  requireAuthorized() {
    this.requireConfigured();
    if (this.auth.stage !== "authorized" || !this.me) {
      throw new Error("Telegram sign-in required");
    }
  }

  statusPayload() {
    return {
      ready: this.configured,
      connected: this.auth.stage === "authorized",
      authStage: this.auth.stage,
      accountLabel: this.me ? peerName(this.me) : undefined,
      passwordHint: this.auth.hint || undefined,
      configured: this.configured,
    };
  }

  async beginQrLogin() {
    this.requireConfigured();
    this.qrAbort?.abort();
    this.qrAbort = new AbortController();
    this.qr = null;
    this.auth = { stage: "qr", phone: "", phoneCodeHash: "", hint: "" };

    this.qrTask = this.client
      .signInQr({
        abortSignal: this.qrAbort.signal,
        onUrlUpdated: async (url, expires) => {
          this.qr = {
            url,
            expiresAt: expires.getTime(),
            image: await QRCode.toDataURL(url, { margin: 1, width: 240 }),
          };
        },
        password: async () => {
          this.auth.stage = "password";
          this.auth.hint = (await this.client.getPasswordHint().catch(() => "")) || "";
          return new Promise((resolve, reject) => {
            this.qrPassword = { resolve, reject };
          });
        },
        invalidPasswordCallback: () => {
          this.auth.stage = "password";
        },
      })
      .then(user => {
        this.me = user;
        this.auth.stage = "authorized";
        this.invalidateMessageViews();
      })
      .catch(error => {
        if (this.qrAbort?.signal.aborted) return;
        this.auth.stage = "phone";
        this.auth.error = errorCode(error);
        this.log("Telegram QR login failed", errorCode(error));
      });

    for (let attempt = 0; attempt < 50 && !this.qr && this.auth.stage === "qr"; attempt++) {
      await delay(100);
    }
    if (!this.qr) throw new Error(this.auth.error || "Telegram did not provide a QR code");
    return this.qr;
  }

  async pollQr(previousToken) {
    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      this.auth.stage === "qr" &&
      this.qr?.url === previousToken
    ) {
      await delay(250);
    }
    return {
      ...this.statusPayload(),
      qr: this.qr,
      error: this.auth.error,
    };
  }

  async submitQrPassword(password) {
    for (let attempt = 0; attempt < 20 && this.auth.stage === "password" && !this.qrPassword; attempt++) {
      await delay(50);
    }
    if (this.auth.stage !== "password" || !this.qrPassword) {
      throw new Error("Telegram is not waiting for a password");
    }
    const waiter = this.qrPassword;
    this.qrPassword = null;
    this.auth.stage = "checking-password";
    waiter.resolve(password);

    for (let attempt = 0; attempt < 80; attempt++) {
      if (["authorized", "password", "phone"].includes(this.auth.stage)) break;
      await delay(100);
    }
    return this.statusPayload();
  }

  async sendPhoneCode(phone) {
    this.requireConfigured();
    this.qrAbort?.abort();
    this.qrTask = null;
    this.qrPassword = null;
    this.qr = null;
    const normalized = String(phone || "").replace(/[^+\d]/g, "");
    if (!/^\+\d{6,15}$/.test(normalized)) {
      throw new Error("Enter the phone number in international format");
    }
    const result = await this.client.sendCode({ phone: normalized });
    if (result?.type === "user") {
      this.me = result;
      this.auth.stage = "authorized";
    } else {
      this.auth = {
        stage: "code",
        phone: normalized,
        phoneCodeHash: result.phoneCodeHash,
        hint: "",
      };
    }
    return this.statusPayload();
  }

  async submitPhoneCode(code) {
    if (this.auth.stage !== "code") throw new Error("Request a Telegram code first");
    try {
      this.me = await this.client.signIn({
        phone: this.auth.phone,
        phoneCodeHash: this.auth.phoneCodeHash,
        phoneCode: String(code || "").trim(),
      });
      this.auth.stage = "authorized";
    } catch (error) {
      if (errorCode(error).includes("SESSION_PASSWORD_NEEDED")) {
        this.auth.hint = (await this.client.getPasswordHint().catch(() => "")) || "";
        this.auth.stage = "password";
      } else {
        throw error;
      }
    }
    return this.statusPayload();
  }

  async submitPhonePassword(password) {
    if (this.auth.stage !== "password") throw new Error("Telegram is not waiting for a password");
    this.me = await this.client.checkPassword(String(password || ""));
    this.auth.stage = "authorized";
    return this.statusPayload();
  }

  async disconnect() {
    this.requireConfigured();
    this.qrAbort?.abort();
    await this.client.logOut().catch(error => this.log("Telegram logout warning", errorCode(error)));
    this.me = null;
    this.auth = { stage: "phone", phone: "", phoneCodeHash: "", hint: "" };
    this.messageCache.clear();
    this.dialogCache = { at: 0, values: [], loaded: false };
    this.dialogRefresh = null;
    this.historyCache.clear();
    this.historyRefreshes.clear();
    this.allowedReactionCache.clear();
    this.floodUntil = 0;
    this.typing.clear();
    this.avatarSources.clear();
    this.avatarDownloads.clear();
    await rm(this.mediaDir, { recursive: true, force: true });
    await mkdir(this.mediaDir, { recursive: true });
  }

  messageReactions(message) {
    const values = [];
    for (const reaction of message.reactions?.recentReactions || []) {
      values.push({
        emoji: normalizeReaction(reaction.emoji),
        author: peerName(reaction.peer, "Telegram user"),
        authorId: String(peerId(reaction.peer) || ""),
        own: peerId(reaction.peer) === peerId(this.me),
      });
    }
    if (values.length) return values;

    for (const reaction of message.reactions?.reactions || []) {
      for (let index = 0; index < Number(reaction.count || 0); index++) {
        values.push({
          emoji: normalizeReaction(reaction.emoji),
          author: reaction.order !== null ? "You" : "Telegram user",
          authorId: reaction.order !== null ? String(peerId(this.me) || "") : "",
          own: reaction.order !== null,
        });
      }
    }
    return values;
  }

  normalizeMessage(message, dialog) {
    const chat = message.chat || dialog?.peer;
    const id = `${peerId(chat)}:${message.id}`;
    const outgoing = Boolean(message.isOutgoing || peerId(chat) === peerId(this.me));
    const readOutboxMaxId = Number(dialog?.readOutboxMaxId ?? dialog?.lastReadOutgoing ?? 0);
    const attachments = [];

    if (message.media && !["web_page", "poll"].includes(message.media.type)) {
      attachments.push({
        id: message.media.fileId || `${peerId(chat)}-${message.id}`,
        contentType: mediaContentType(message.media),
        filename: message.media.fileName || message.media.type || "attachment",
        size: Number(message.media.fileSize || 0),
        width: Number(message.media.width || 0),
        height: Number(message.media.height || 0),
      });
    }

    const normalized = {
      id,
      telegramId: message.id,
      conversationId: conversationId(chat),
      direction: message.isService ? "system" : outgoing ? "out" : "in",
      sender: outgoing ? "You" : message.signature || peerName(message.sender, "Telegram user"),
      senderId: peerId(message.sender),
      text: message.isService ? serviceMessageText(message) : message.text || "",
      timestamp: message.date?.getTime?.() || Date.now(),
      edited: Boolean(message.editDate),
      pinned: Boolean(message.isPinned),
      deleted: false,
      // Telegram exposes the peer's read maximum, but not a separate recipient
      // delivery event. A successfully accepted outgoing message is delivered.
      status: outgoing ? (message.id <= readOutboxMaxId ? "read" : "delivered") : undefined,
      receipts: {},
      attachments,
      previews: linkPreviews(message, this.state.settings.linkPreviews),
      reactions: this.messageReactions(message),
      quote: message.replyToMessage
        ? {
            telegramId: message.replyToMessage.messageId || message.replyToMessage.id,
            timestamp: message.replyToMessage.date?.getTime?.() || 0,
            author: message.replyToMessage.isOutgoing
              ? "You"
              : peerName(message.replyToMessage.sender, "Reply"),
            text: message.replyToMessage.text || message.replyToMessage.message || message.replyToMessage.media?.type || "Quoted message",
          }
        : null,
      poll: pollFromMessage(message),
      forwardedFrom: message.forward ? forwardedName(message) : undefined,
      sticker: message.media?.type === "sticker" ? { path: true } : undefined,
    };

    Object.defineProperty(normalized, "_raw", { value: message, enumerable: false });
    Object.defineProperty(normalized, "_rawAttachments", {
      value: message.media ? [message] : [],
      enumerable: false,
      writable: true,
    });
    Object.defineProperty(normalized, "_groupedId", {
      value: message.groupedIdUnique || null,
      enumerable: false,
    });
    this.messageCache.set(id, normalized);
    return normalized;
  }

  mergeGroupedMessages(messages) {
    const merged = [];
    const albums = new Map();
    for (const message of messages) {
      if (!message._groupedId) {
        merged.push(message);
        continue;
      }

      const existing = albums.get(message._groupedId);
      if (!existing) {
        albums.set(message._groupedId, message);
        merged.push(message);
        continue;
      }

      existing.attachments.push(...message.attachments);
      existing._rawAttachments.push(...message._rawAttachments);
      if (!existing.text && message.text) existing.text = message.text;
      if (!existing.quote && message.quote) existing.quote = message.quote;
      if (!existing.forwardedFrom && message.forwardedFrom) {
        existing.forwardedFrom = message.forwardedFrom;
      }
      if (!existing.reactions.length && message.reactions.length) {
        existing.reactions = message.reactions;
      }
      this.messageCache.set(message.id, existing);
    }
    return merged;
  }

  async enrichQuote(normalized, raw) {
    if (!normalized.quote?.telegramId) return normalized;
    try {
      const [quoted] = await this.client.getMessages(peerId(raw.chat), [normalized.quote.telegramId]);
      if (quoted) {
        normalized.quote = {
          telegramId: quoted.id,
          timestamp: quoted.date?.getTime?.() || 0,
          author: peerId(quoted.sender) === peerId(this.me) ? "You" : peerName(quoted.sender),
          text: quoted.text || (quoted.media ? quoted.media.type || "Media" : "Message"),
        };
      }
    } catch {}
    return normalized;
  }

  activeTyping(target) {
    const entry = this.typing.get(Number(target));
    if (!entry || entry.until <= Date.now()) {
      this.typing.delete(Number(target));
      return [];
    }
    return [entry.name];
  }

  async dialogs() {
    const cacheAvailable = this.dialogCache.loaded;
    if (cacheAvailable && Date.now() - this.dialogCache.at < DIALOG_CACHE_MS) {
      return this.dialogCache.values;
    }
    if (this.dialogRefresh) return this.dialogRefresh;
    if (cacheAvailable && Date.now() < this.floodUntil) return this.dialogCache.values;

    this.dialogRefresh = (async () => {
      try {
        const values = [];
        for await (const dialog of this.client.iterDialogs({ limit: 300 })) {
          const peer = dialog.peer;
          const id = peerId(peer);
          if (!Number.isSafeInteger(id)) continue;
          const avatar = peer.photo?.big || peer.photo?.small || peer.photo;
          const avatarVersion = avatar?.uniqueFileId || avatar?.fileId || "current";
          const details = this.detailCache.get(String(id))?.value;
          if (avatar) this.avatarSources.set(String(id), avatar);
          const last = dialog.lastMessage ? this.normalizeMessage(dialog.lastMessage, dialog) : null;
          values.push({
            id: conversationId(peer),
            kind: conversationKind(peer),
            target: String(id),
            name: id === peerId(this.me) ? "Saved Messages" : peerName(peer),
            noteToSelf: id === peerId(this.me),
            archived: Boolean(dialog.isArchived),
            favorite: Boolean(dialog.isPinned),
            muted: Boolean(dialog.isMuted),
            unread: Number(dialog.unreadCount || 0),
            last,
            typing: this.activeTyping(id),
            avatar: avatar
              ? `/api/services/telegram/avatar/${encodeURIComponent(id)}?v=${encodeURIComponent(avatarVersion)}`
              : null,
            blocked: false,
            expiration: Number(dialog.ttlPeriod || 0),
            description: details?.description,
            members: details?.members || [],
            admins: details?.admins || [],
            permissions: {},
            readInboxMaxId: Number(dialog.lastReadIngoing || 0),
            readOutboxMaxId: Number(dialog.lastReadOutgoing || 0),
          });
        }
        this.dialogCache = { at: Date.now(), values, loaded: true };
        return values;
      } catch (error) {
        const wait = floodWaitSeconds(error);
        if (!wait) throw error;
        this.floodUntil = Math.max(this.floodUntil, Date.now() + wait * 1_000);
        this.log(`Telegram flood wait: pausing refreshes for ${wait}s`);
        if (cacheAvailable) return this.dialogCache.values;
        throw new Error(`Telegram is rate-limiting refreshes. Try again in ${wait} seconds.`);
      } finally {
        this.dialogRefresh = null;
      }
    })();
    return this.dialogRefresh;
  }

  async conversation(target) {
    return this.cachedConversation(target) ||
      (await this.dialogs()).find(item => item.target === String(target));
  }

  cachedConversation(target) {
    return this.dialogCache.values.find(item => item.target === String(target));
  }

  async conversationDetails(target, kind) {
    const resolvedTarget = inputTarget(target);
    const cached = this.detailCache.get(String(resolvedTarget));
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;

    const value = {
      description: undefined,
      members: [],
      admins: [],
      inviteLink: undefined,
      blocked: false,
    };
    try {
      const full = await this.client.getFullChat(resolvedTarget);
      value.description = full.bio || full.about || undefined;
      value.inviteLink = full.inviteLink?.link || undefined;
      value.blocked = Boolean(full.isBlocked);
    } catch {}

    if (kind === "group") {
      try {
        const members = await this.client.getChatMembers(resolvedTarget, {
          type: "recent",
          limit: 200,
        });
        value.members = members.map(member => ({
          id: String(peerId(member.user)),
          name: peerName(member.user, "Telegram user"),
        }));
        value.admins = members
          .filter(member => member.status === "admin" || member.status === "creator")
          .map(member => String(peerId(member.user)));
      } catch {}
    }

    this.detailCache.set(String(resolvedTarget), { at: Date.now(), value });
    const dialog = this.cachedConversation(resolvedTarget);
    if (dialog) {
      dialog.description = value.description;
      dialog.members = value.members;
      dialog.admins = value.admins;
    }
    return value;
  }

  findMessage(input) {
    const target = String(input.target ?? input.conversationId?.split(":").at(-1) ?? "");
    return [...this.messageCache.values()].find(message => {
      const sameConversation = /^-?\d+$/.test(target)
        ? message.conversationId.endsWith(`:${target}`)
        : true;
      const sameMessage =
        message.telegramId === Number(input.messageId) ||
        message.timestamp === Number(input.timestamp);
      return sameConversation && sameMessage;
    });
  }

  async globalReactions() {
    if (this.reactionCache.values.length && Date.now() - this.reactionCache.at < 6 * 60 * 60_000) {
      return this.reactionCache.values;
    }
    const result = await this.client.call({ _: "messages.getAvailableReactions", hash: 0 });
    if (result._ === "messages.availableReactions") {
      this.reactionCache = {
        at: Date.now(),
        values: result.reactions
          .filter(reaction => !reaction.inactive && (!reaction.premium || this.me?.isPremium))
          .map(reaction => normalizeReaction(reaction.reaction)),
      };
    }
    return this.reactionCache.values.length ? this.reactionCache.values : FALLBACK_REACTIONS;
  }

  async allowedReactions(target) {
    const key = String(target);
    const cached = this.allowedReactionCache.get(key);
    if (cached && Date.now() - cached.at < ALLOWED_REACTIONS_CACHE_MS) return cached.values;

    const global = await this.globalReactions().catch(() => FALLBACK_REACTIONS);
    let values = global;
    try {
      const full = await this.client.getFullChat(inputTarget(target));
      const available = full.availableReactions ?? full.full?.availableReactions;
      if (available?._ === "chatReactionsNone") values = [];
      if (available?._ === "chatReactionsSome") {
        values = available.reactions
          .filter(reaction => reaction._ === "reactionEmoji")
          .map(reaction => normalizeReaction(reaction.emoticon))
          .filter(reaction => global.includes(reaction));
      }
    } catch {}
    this.allowedReactionCache.set(key, { at: Date.now(), values });
    return values;
  }

  async messageHistory(target, kind, before) {
    const key = `${target}:${before || "latest"}`;
    const cached = this.historyCache.get(key);
    const maxAge = before ? PAGED_HISTORY_CACHE_MS : HISTORY_CACHE_MS;
    if (cached && Date.now() - cached.at < maxAge) {
      return { ...cached.value, typing: this.activeTyping(target) };
    }
    if (this.historyRefreshes.has(key)) return this.historyRefreshes.get(key);

    if (Date.now() < this.floodUntil) {
      if (cached) return { ...cached.value, typing: this.activeTyping(target) };
      const remaining = Math.max(1, Math.ceil((this.floodUntil - Date.now()) / 1_000));
      throw new Error(`Telegram is rate-limiting refreshes. Try again in ${remaining} seconds.`);
    }

    const refresh = (async () => {
      try {
        const dialog = await this.conversation(target);
        const normalized = [];
        for await (const message of this.client.iterHistory(target, {
          limit: 60,
          ...(before ? { offset: { id: 0, date: Math.floor(before / 1_000) } } : {}),
        })) {
          normalized.push(this.normalizeMessage(message, dialog));
        }
        const rawCount = normalized.length;
        const messages = this.mergeGroupedMessages(normalized.reverse());
        for (const message of messages) await this.enrichQuote(message, message._raw);
        if (!before && dialog && messages.length) dialog.last = messages.at(-1);
        const readInboxMaxId = Number(dialog?.readInboxMaxId || 0);
        const readThrough = messages
          .filter(message => message.direction === "in" && message.telegramId <= readInboxMaxId)
          .at(-1)?.timestamp || 0;
        const value = {
          messages,
          hasMore: rawCount === 60,
          readThrough,
          allowedReactions: await this.allowedReactions(target),
          conversation: await this.conversationDetails(target, kind),
        };
        this.historyCache.set(key, { at: Date.now(), value });
        return { ...value, typing: this.activeTyping(target) };
      } catch (error) {
        const wait = floodWaitSeconds(error);
        if (!wait) throw error;
        this.floodUntil = Math.max(this.floodUntil, Date.now() + wait * 1_000);
        this.log(`Telegram flood wait: pausing refreshes for ${wait}s`);
        if (cached) return { ...cached.value, typing: this.activeTyping(target) };
        throw new Error(`Telegram is rate-limiting refreshes. Try again in ${wait} seconds.`);
      } finally {
        this.historyRefreshes.delete(key);
      }
    })();
    this.historyRefreshes.set(key, refresh);
    return refresh;
  }

  async serveAttachment(req, res, normalized, index) {
    const raw = normalized._rawAttachments[index];
    const attachment = normalized.attachments[index];
    if (!raw?.media || !attachment) throw new Error("Attachment unavailable");
    const cacheId = `${normalized.id}:${index}`;
    const path = join(this.mediaDir, Buffer.from(cacheId).toString("base64url"));
    let information = await stat(path).catch(() => null);
    if (information?.isFile() && information.size === 0) {
      await unlink(path).catch(() => {});
      information = null;
    }

    if (!information?.isFile()) {
      if (!this.mediaDownloads.has(path)) {
        this.mediaDownloads.set(
          path,
          (async () => {
            const temporary = `${path}.${randomBytes(5).toString("hex")}.tmp`;
            try {
              await this.client.downloadToFile(temporary, raw.media);
              const downloaded = await stat(temporary);
              if (!downloaded.size) throw new Error("Telegram returned an empty attachment");
              await rename(temporary, path);
            } finally {
              await unlink(temporary).catch(() => {});
              this.mediaDownloads.delete(path);
            }
          })(),
        );
      }
      await this.mediaDownloads.get(path);
      information = await stat(path);
    }

    const contentType = attachment.contentType || "application/octet-stream";
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = Math.min(range[2] ? Number(range[2]) : information.size - 1, information.size - 1);
      if (start > end || start >= information.size) {
        res.writeHead(416, { "content-range": `bytes */${information.size}` });
        return res.end();
      }
      res.writeHead(206, {
        "content-type": contentType,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${information.size}`,
        "accept-ranges": "bytes",
        "cache-control": "private, max-age=86400",
      });
      return createReadStream(path, { start, end }).pipe(res);
    }

    res.writeHead(200, {
      "content-type": contentType,
      "content-length": information.size,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=86400",
    });
    return createReadStream(path).pipe(res);
  }

  async serveAvatar(res, target, version) {
    const cacheId = `avatar:${target}:${version}`;
    const path = join(this.mediaDir, Buffer.from(cacheId).toString("base64url"));
    let information = await stat(path).catch(() => null);

    if (!information?.isFile() || !information.size) {
      if (!this.avatarDownloads.has(path)) {
        this.avatarDownloads.set(
          path,
          (async () => {
            const temporary = `${path}.${randomBytes(5).toString("hex")}.tmp`;
            try {
              let source = this.avatarSources.get(String(target));
              if (!source) {
                const peer = await this.client.getPeer(target);
                source = peer.photo?.big || peer.photo?.small || peer.photo;
              }
              if (!source) throw new Error("Avatar unavailable");
              await this.client.downloadToFile(temporary, source);
              const downloaded = await stat(temporary);
              if (!downloaded.size) throw new Error("Telegram returned an empty avatar");
              await rename(temporary, path);
            } finally {
              await unlink(temporary).catch(() => {});
              this.avatarDownloads.delete(path);
            }
          })(),
        );
      }
      await this.avatarDownloads.get(path);
      information = await stat(path);
    }

    res.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": information.size,
      "cache-control": "private, max-age=86400",
    });
    return createReadStream(path).pipe(res);
  }

  async receiveRaw(req, limit = 50_000_000) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error("Upload is too large");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async handle(req, res, url, { body, json }) {
    const root = "/api/services/telegram";
    const path = url.pathname.slice(root.length) || "/";

    if (path === "/status" && req.method === "GET") {
      if (this.configured) await this.refreshAuthorization();
      return json(res, 200, this.statusPayload());
    }
    if (path === "/configure" && req.method === "POST") {
      const input = await body(req);
      return json(res, 200, await this.configure(input.apiId, input.apiHash));
    }
    if (!this.configured) return json(res, 409, { error: "Telegram API credentials are not configured" });

    if (path === "/auth/qr/start" && req.method === "POST") {
      const qr = await this.beginQrLogin();
      return json(res, 200, { ...this.statusPayload(), qr });
    }
    if (path === "/auth/qr/poll" && req.method === "GET") {
      return json(res, 200, await this.pollQr(url.searchParams.get("token")));
    }
    if (path === "/auth/qr/password" && req.method === "POST") {
      const input = await body(req);
      return json(res, 200, await this.submitQrPassword(input.password));
    }
    if (path === "/auth/phone" && req.method === "POST") {
      const input = await body(req);
      return json(res, 200, await this.sendPhoneCode(input.phone));
    }
    if (path === "/auth/code" && req.method === "POST") {
      const input = await body(req);
      return json(res, 200, await this.submitPhoneCode(input.code));
    }
    if (path === "/auth/password" && req.method === "POST") {
      const input = await body(req);
      const result = this.qrTask
        ? await this.submitQrPassword(input.password)
        : await this.submitPhonePassword(input.password);
      return json(res, 200, result);
    }
    if (path === "/disconnect" && req.method === "POST") {
      await this.disconnect();
      return json(res, 200, { disconnected: true });
    }

    this.requireAuthorized();

    if (path === "/conversations" && req.method === "GET") {
      const archived = url.searchParams.get("archived") === "1";
      const dialogs = await this.dialogs();
      return json(res, 200, {
        conversations: dialogs
          .filter(item => item.archived === archived)
          .map(item => ({ ...item, typing: this.activeTyping(item.target) })),
        archivedCount: dialogs.filter(item => item.archived).length,
      });
    }

    if (path.startsWith("/messages/") && req.method === "GET") {
      const conversation = decodeURIComponent(path.slice("/messages/".length));
      const target = inputTarget(conversation.split(":").at(-1));
      const kind = conversation.split(":")[0];
      const before = Number(url.searchParams.get("before") || 0);
      return json(res, 200, await this.messageHistory(target, kind, before));
    }

    if (path === "/read" && req.method === "POST") {
      const input = await body(req);
      const target = inputTarget(String(input.conversationId).split(":").at(-1));
      const dialog = await this.conversation(target);
      const maxId = Number(input.maxMessageId || dialog?.last?.telegramId || 0);
      await this.client.readHistory(target, { maxId, clearMentions: true });
      if (dialog) {
        dialog.readInboxMaxId = Math.max(dialog.readInboxMaxId, maxId);
        dialog.unread = 0;
      }
      this.historyCache.clear();
      return json(res, 200, { ok: true });
    }

    if (path === "/typing" && req.method === "POST") {
      const input = await body(req);
      if (this.state.settings.sendTypingIndicators) {
        await this.client.setTyping({
          peerId: inputTarget(input.target),
          status: input.stop ? "cancel" : "typing",
        });
      }
      return json(res, 200, { ok: true });
    }

    if (path === "/send" && req.method === "POST") {
      const input = await body(req);
      const reply = this.findMessage({ target: input.target, timestamp: input.quoteTimestamp });
      const sent = await this.client.sendText(inputTarget(input.target), String(input.message || "").trim(), {
        ...(reply ? { replyTo: reply.telegramId } : {}),
        disableWebPreview: !this.state.settings.linkPreviews,
      });
      this.invalidateMessageViews();
      return json(res, 200, { message: this.normalizeMessage(sent) });
    }

    if (path === "/reaction" && req.method === "POST") {
      const input = await body(req);
      const message = this.findMessage(input);
      if (!message) return json(res, 404, { error: "Message is no longer loaded" });
      const selected = normalizeReaction(input.emoji);
      if (!input.remove && !(await this.allowedReactions(input.target)).includes(selected)) {
        return json(res, 400, { error: "That reaction is not allowed in this Telegram chat" });
      }
      try {
        await this.client.sendReaction({
          chatId: inputTarget(input.target),
          message: message.telegramId,
          emoji: input.remove ? null : selected.replaceAll("\uFE0F", ""),
          shouldDispatch: true,
        });
      } catch (error) {
        if (errorCode(error).includes("REACTION_INVALID")) {
          return json(res, 400, { error: "That reaction is not allowed in this Telegram chat" });
        }
        throw error;
      }
      return json(res, 200, { ok: true });
    }

    if (path === "/receipt" && req.method === "GET") {
      const target = inputTarget(url.searchParams.get("target"));
      const messageId = Number(url.searchParams.get("messageId"));
      try {
        const peer = await this.client.resolvePeer(target);
        const receipts = await this.client.call({
          _: "messages.getMessageReadParticipants",
          peer,
          msgId: messageId,
        });
        const users = await this.client.getPeers(receipts.map(receipt => receipt.userId));
        return json(res, 200, {
          readBy: receipts.map((receipt, index) => ({
            name: peerName(users[index], "Telegram user"),
            at: Number(receipt.date) * 1000,
          })),
        });
      } catch (error) {
        if (["CHAT_TOO_BIG", "MSG_TOO_OLD", "MSG_ID_INVALID"].some(code => errorCode(error).includes(code))) {
          return json(res, 200, { readBy: [] });
        }
        throw error;
      }
    }

    if (path === "/edit" && req.method === "POST") {
      const input = await body(req);
      const message = this.findMessage(input);
      if (!message) return json(res, 404, { error: "Message is no longer loaded" });
      await this.client.editMessage({
        chatId: inputTarget(input.target),
        message: message.telegramId,
        text: String(input.message || "").trim(),
        shouldDispatch: true,
      });
      return json(res, 200, { ok: true });
    }

    if (path === "/delete" && req.method === "POST") {
      const input = await body(req);
      const message = this.findMessage(input);
      if (!message) return json(res, 404, { error: "Message is no longer loaded" });
      await this.client.deleteMessagesById(inputTarget(input.target), [message.telegramId], {
        revoke: true,
        shouldDispatch: true,
      });
      this.invalidateMessageViews();
      return json(res, 200, { ok: true });
    }

    if (path === "/pin" && req.method === "POST") {
      const input = await body(req);
      const message = this.findMessage(input);
      if (!message) return json(res, 404, { error: "Message is no longer loaded" });
      if (input.pinned) {
        await this.client.pinMessage({ chatId: inputTarget(input.target), message: message.telegramId });
      } else {
        await this.client.unpinMessage({ chatId: inputTarget(input.target), message: message.telegramId });
      }
      return json(res, 200, { ok: true });
    }

    if (path.startsWith("/pins/") && req.method === "GET") {
      const target = inputTarget(decodeURIComponent(path.slice("/pins/".length)).split(":").at(-1));
      const pins = [];
      for await (const message of this.client.iterHistory(target, { limit: 300 })) {
        if (message.isPinned) pins.push(this.normalizeMessage(message));
      }
      return json(res, 200, { pins });
    }

    if (path === "/conversation" && req.method === "POST") {
      const input = await body(req);
      const target = inputTarget(String(input.conversationId).split(":").at(-1));
      if (typeof input.archived === "boolean") {
        if (input.archived) await this.client.archiveChats(target);
        else await this.client.unarchiveChats(target);
      }
      if (typeof input.favourite === "boolean") {
        const peer = await this.client.resolvePeer(target);
        await this.client.call({
          _: "messages.toggleDialogPin",
          pinned: input.favourite,
          peer: { _: "inputDialogPeer", peer },
        });
      }
      if (typeof input.muted === "boolean") {
        const peer = await this.client.resolvePeer(target);
        await this.client.call({
          _: "account.updateNotifySettings",
          peer: { _: "inputNotifyPeer", peer },
          settings: {
            _: "inputPeerNotifySettings",
            muteUntil: input.muted ? 2_147_483_647 : 0,
          },
        });
      }
      if (typeof input.expiration === "number") {
        await this.client.setChatTtl(target, input.expiration);
      }
      this.invalidateMessageViews();
      return json(res, 200, { ok: true });
    }

    if (path === "/block" && req.method === "POST") {
      const input = await body(req);
      if (input.blocked) await this.client.blockUser(inputTarget(input.target));
      else await this.client.unblockUser(inputTarget(input.target));
      return json(res, 200, { ok: true });
    }

    if (path === "/search" && req.method === "GET") {
      const results = [];
      const found = await this.client.searchGlobal({
        query: url.searchParams.get("q") || "",
        limit: 50,
      });
      for (const message of found) {
        const normalized = this.normalizeMessage(message);
        results.push({
          conversationId: normalized.conversationId,
          timestamp: normalized.timestamp,
          sender: normalized.sender,
          text: normalized.text || normalized.attachments[0]?.filename || "Media",
        });
      }
      return json(res, 200, { results });
    }

    if (path === "/settings" && req.method === "GET") {
      const defaultTtl = await this.client
        .call({ _: "messages.getDefaultHistoryTTL" })
        .catch(() => null);
      if (defaultTtl?.period !== undefined) {
        this.state.settings.defaultExpiration = Number(defaultTtl.period);
      }
      return json(res, 200, { settings: this.state.settings });
    }
    if (path === "/settings" && req.method === "POST") {
      const input = await body(req);
      if (
        typeof input.defaultExpiration === "number" &&
        input.defaultExpiration !== this.state.settings.defaultExpiration
      ) {
        await this.client.call({
          _: "messages.setDefaultHistoryTTL",
          period: input.defaultExpiration,
        });
      }
      this.state.settings = { ...this.state.settings, ...input };
      await this.persistState();
      return json(res, 200, { settings: this.state.settings });
    }

    if (path === "/group/create" && req.method === "POST") {
      const input = await body(req);
      await this.client.createGroup({
        title: String(input.name || "").trim(),
        users: (input.members || []).map(value => Number(value)),
      });
      this.invalidateMessageViews();
      return json(res, 200, { ok: true });
    }

    if (path === "/group/update" && req.method === "POST") {
      const input = await body(req);
      const target = inputTarget(input.target);
      if (typeof input.name === "string") await this.client.setChatTitle(target, input.name);
      if (typeof input.description === "string") {
        await this.client.setChatDescription(target, input.description);
      }
      if (Array.isArray(input.addMembers) && input.addMembers.length) {
        await this.client.addChatMembers(target, input.addMembers.map(Number), { forwardCount: 0 });
      }
      this.invalidateMessageViews();
      return json(res, 200, { ok: true });
    }

    if (path === "/group/leave" && req.method === "POST") {
      const input = await body(req);
      await this.client.leaveChat(inputTarget(input.target));
      this.invalidateMessageViews();
      return json(res, 200, { ok: true });
    }

    if (path === "/poll/create" && req.method === "POST") {
      const input = await body(req);
      const answers = (input.options || []).map(value => String(value).trim()).filter(Boolean);
      if (!String(input.question || "").trim() || answers.length < 2) {
        return json(res, 400, { error: "A poll needs a question and at least two choices" });
      }
      await this.client.sendMedia(inputTarget(input.target), {
        type: "poll",
        question: String(input.question).trim(),
        answers,
        multiple: Boolean(input.multiple),
      });
      return json(res, 200, { ok: true });
    }

    if (path === "/poll/vote" && req.method === "POST") {
      const input = await body(req);
      const message = this.findMessage(input);
      if (!message) return json(res, 404, { error: "Poll is no longer loaded" });
      await this.client.sendVote({
        chatId: inputTarget(input.target),
        message: message.telegramId,
        options: input.options || [],
      });
      return json(res, 200, { ok: true });
    }

    if (path === "/poll/close" && req.method === "POST") {
      const input = await body(req);
      const message = this.findMessage(input);
      if (!message) return json(res, 404, { error: "Poll is no longer loaded" });
      await this.client.closePoll({
        chatId: inputTarget(input.target),
        message: message.telegramId,
        shouldDispatch: true,
      });
      return json(res, 200, { ok: true });
    }

    if (path === "/forward" && req.method === "POST") {
      const input = await body(req);
      const message = this.findMessage({ target: input.fromTarget, messageId: input.messageId });
      if (!message) return json(res, 404, { error: "Message is no longer loaded" });
      await this.client.forwardMessagesById({
        fromChatId: inputTarget(input.fromTarget),
        toChatId: inputTarget(input.target),
        messages: [message.telegramId],
      });
      return json(res, 200, { ok: true });
    }

    if (path === "/attachment/send" && req.method === "POST") {
      const target = inputTarget(url.searchParams.get("target"));
      const filename = basename(url.searchParams.get("filename") || "attachment");
      const caption = url.searchParams.get("caption") || "";
      const bytes = await this.receiveRaw(req);
      const temporary = join(this.mediaDir, `upload-${randomBytes(8).toString("hex")}-${filename}`);
      try {
        await writeFile(temporary, bytes, { mode: 0o600 });
        // mtcute treats every bare string as a Telegram file ID. The explicit
        // file: prefix makes this local path an upload source instead.
        await this.client.sendMedia(target, `file:${temporary}`, { caption });
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return json(res, 200, { ok: true });
    }

    if (path === "/voice" && req.method === "POST") {
      const target = inputTarget(url.searchParams.get("target"));
      const bytes = await this.receiveRaw(req, 20_000_000);
      const temporary = join(this.mediaDir, `voice-${randomBytes(8).toString("hex")}.ogg`);
      try {
        await writeFile(temporary, bytes, { mode: 0o600 });
        await this.client.sendMedia(target, { type: "voice", file: `file:${temporary}` });
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return json(res, 200, { ok: true });
    }

    if (path.startsWith("/attachment/") && req.method === "GET") {
      const [encodedId, rawIndex] = path.slice("/attachment/".length).split("/");
      const id = decodeURIComponent(encodedId);
      const index = Number(rawIndex || 0);
      const message = this.messageCache.get(id);
      if (!message?._rawAttachments?.[index]?.media) {
        return json(res, 404, { error: "Attachment unavailable" });
      }
      return this.serveAttachment(req, res, message, index);
    }

    if (path.startsWith("/avatar/") && req.method === "GET") {
      const target = Number(decodeURIComponent(path.slice("/avatar/".length)));
      try {
        return await this.serveAvatar(res, target, url.searchParams.get("v") || "current");
      } catch {
        return json(res, 404, { error: "Avatar unavailable" });
      }
    }

    return json(res, 404, { error: "Not found" });
  }

  async shutdown() {
    this.qrAbort?.abort();
    await this.client?.destroy().catch(() => {});
  }
}
