import { api, widgetToken } from '../api/client';
import type {
	ConversationPage,
	MessagePage,
	MessagingService,
	ServiceCapabilities,
	ServiceStatus,
	UniversalConversation,
	UniversalMessage,
	UniversalSearchResult,
	UniversalSettings,
	UniversalSticker,
} from './contracts';

type SignalStatusResponse = {
	signalReady: boolean;
	linked: boolean;
	accounts?: string[];
	settings?: UniversalSettings;
};

type SignalMessage = {
	id: string;
	conversationId: string;
	timestamp: number;
	direction: 'in' | 'out' | 'system';
	sender?: string;
	text?: string;
	attachments?: { id?: string; contentType?: string; filename?: string; size?: number; caption?: string; width?: number; height?: number }[];
	reactions?: { emoji: string; author?: string; authorId?: string; own?: boolean }[];
	status?: 'sent' | 'delivered' | 'read';
	quote?: { author?: string; text?: string; timestamp?: number };
	edited?: boolean;
	deleted?: boolean;
	pinned?: boolean;
	poll?: {
		question: string;
		options: { index: number; text: string; votes: string[] }[];
		multiple?: boolean;
		closed?: boolean;
	};
	viewOnce?: boolean;
	viewOnceOpened?: boolean;
	receipts?: Record<string, { status?: string; name?: string; at?: number }>;
	previews?: { title?: string; description?: string; url?: string }[];
	sticker?: { packId: string; stickerId: string };
	forwardedFrom?: string;
	mentions?: {
		start?: number;
		length?: number;
		name?: string;
		profileName?: string;
		number?: string;
		recipient?: { name?: string; profileName?: string; number?: string };
	}[];
};

type SignalConversation = {
	id: string;
	kind: 'direct' | 'group';
	target: string;
	name: string;
	archived?: boolean;
	favorite?: boolean;
	muted?: boolean;
	noteToSelf?: boolean;
	unread?: number;
	typing?: string[];
	avatar?: string | null;
	last?: SignalMessage;
	expiration?: number;
	blocked?: boolean;
	messageRequest?: boolean;
	identityChanged?: boolean;
	invited?: boolean;
	description?: string;
	members?: { id: string; name: string }[];
	admins?: string[];
	inviteLink?: string;
	permissions?: Record<string, string>;
};

type SignalConversationResponse = {
	conversations: SignalConversation[];
	archivedCount: number;
};

type SignalMessageResponse = {
	messages: SignalMessage[];
	hasMore: boolean;
	readThrough: number;
	typing?: string[];
};

function attachmentKind(contentType?: string): 'image' | 'video' | 'audio' | 'file' {
	if (contentType?.startsWith('image/')) return 'image';
	if (contentType?.startsWith('video/')) return 'video';
	if (contentType?.startsWith('audio/')) return 'audio';
	return 'file';
}

function mentionText(value = '', mentions: SignalMessage['mentions'] = []) {
	let text = value;
	for (const mention of [...mentions].sort(
		(first, second) => Number(second.start ?? 0) - Number(first.start ?? 0),
	)) {
		const start = Number(mention.start ?? 0);
		const length = Number(mention.length ?? 1);
		const name =
			mention.name ??
			mention.profileName ??
			mention.recipient?.name ??
			mention.recipient?.profileName ??
			mention.number ??
			mention.recipient?.number ??
			'Someone';
		text = `${text.slice(0, start)}@${name}${text.slice(start + length)}`;
	}
	return text;
}

function toUniversalMessage(message: SignalMessage): UniversalMessage {
	return {
		id: `signal:${message.id}`,
		conversationId: `signal:${message.conversationId}`,
		sentAt: message.timestamp,
		direction: message.direction === 'in' ? 'incoming' : message.direction === 'out' ? 'outgoing' : 'system',
		sender: message.sender,
		text: mentionText(message.text, message.mentions),
		attachments: (message.attachments ?? []).map((attachment, index) => ({
			id: attachment.id ?? String(index),
			path: `/api/attachment/${encodeURIComponent(message.id)}/${index}`,
			kind: attachmentKind(attachment.contentType),
			contentType: attachment.contentType,
			filename: attachment.filename,
			size: attachment.size,
			caption: attachment.caption,
			width: attachment.width,
			height: attachment.height,
		})),
		reactions: (message.reactions ?? []).map((reaction) => ({
			emoji: reaction.emoji,
			author: reaction.author ?? 'Someone',
			isOwn: Boolean(reaction.own),
			avatarPath: reaction.authorId
				? `/api/avatar/direct/${encodeURIComponent(reaction.authorId)}`
				: undefined,
		})),
		receipt:
			message.direction === 'out'
				? {
						state: message.status ?? 'sent',
						readBy: Object.values(message.receipts ?? {}).map((receipt) => ({
							name: receipt.name ?? 'Recipient',
							status: receipt.status === 'read' || receipt.status === 'viewed' ? receipt.status : 'delivered',
							at: receipt.at,
						})),
					}
				: undefined,
		quote: message.quote?.author
			? { author: message.quote.author, text: message.quote.text, sentAt: message.quote.timestamp }
			: undefined,
		edited: message.edited,
		deleted: message.deleted,
		pinned: message.pinned,
		poll: message.poll
			? { ...message.poll, multiple: Boolean(message.poll.multiple), closed: Boolean(message.poll.closed) }
			: undefined,
		viewOnce: message.viewOnce ? { opened: Boolean(message.viewOnceOpened) } : undefined,
		previews: message.previews?.map((preview) => ({
			title: preview.title ?? preview.url ?? 'Link',
			description: preview.description,
			url: preview.url,
		})),
		stickerPath: message.sticker
			? `/api/sticker/${encodeURIComponent(message.sticker.packId)}/${encodeURIComponent(message.sticker.stickerId)}`
			: undefined,
		forwardedFrom: message.forwardedFrom,
	};
}

function toUniversalConversation(conversation: SignalConversation): UniversalConversation {
	return {
		id: `signal:${conversation.id}`,
		serviceId: 'signal',
		remoteId: conversation.id,
		kind: conversation.kind,
		title: conversation.name,
		isNoteToSelf: Boolean(conversation.noteToSelf),
		isArchived: Boolean(conversation.archived),
		isFavourite: Boolean(conversation.favorite),
		isMuted: Boolean(conversation.muted),
		unreadCount: conversation.unread ?? 0,
		typingNames: conversation.typing ?? [],
		avatarPath: conversation.avatar ?? undefined,
		lastMessage: conversation.last ? toUniversalMessage(conversation.last) : undefined,
		expiration: conversation.expiration ?? 0,
		isBlocked: Boolean(conversation.blocked),
		isMessageRequest: Boolean(conversation.messageRequest),
		isIdentityChanged: Boolean(conversation.identityChanged),
		isInvited: Boolean(conversation.invited),
		description: conversation.description,
		members: conversation.members ?? [],
		adminIds: conversation.admins ?? [],
		inviteLink: conversation.inviteLink,
		permissions: conversation.permissions ?? {},
	};
}

export const signalService: MessagingService = {
	id: 'signal',
	label: 'Signal',

	async getStatus(): Promise<ServiceStatus> {
		const response = await api<SignalStatusResponse>('/api/status');
		return {
			id: 'signal',
			label: 'Signal',
			ready: response.signalReady,
			connected: response.linked,
			accountLabel: response.accounts?.[0],
		};
	},

	async beginSetup() {
		const response = await api<{ uri: string; qr: string }>('/api/link/start', {
			method: 'POST',
		});
		return {
			kind: 'qr' as const,
			token: response.uri,
			title: 'Link Signal',
			instructions: 'Signal → Settings → Linked devices → Link new device',
			image: response.qr,
		};
	},

	async advanceSetup(step) {
		if (step.kind !== 'qr') throw new Error('Signal expected a QR setup step');
		await api<{ linked: boolean }>('/api/link/finish', {
			method: 'POST',
			body: JSON.stringify({ uri: step.token }),
		});
		return {
			kind: 'complete' as const,
			title: 'Signal linked',
			instructions: 'Contacts and new messages will begin syncing shortly.',
		};
	},

	async disconnect() {
		await api<{ disconnected: boolean }>('/api/services/signal/disconnect', {
			method: 'POST',
			body: JSON.stringify({ confirm: 'disconnect-signal' }),
		});
	},

	async listConversations({ archived }): Promise<ConversationPage> {
		const response = await api<SignalConversationResponse>(
			`/api/conversations${archived ? '?archived=1' : ''}`,
		);
		return {
			conversations: response.conversations.map(toUniversalConversation),
			archivedCount: response.archivedCount,
		};
	},

	async listMessages(conversation, { before } = {}): Promise<MessagePage> {
		const query = before ? `?before=${before}` : '';
		const response = await api<SignalMessageResponse>(
			`/api/messages/${encodeURIComponent(conversation.remoteId)}${query}`,
		);
		return {
			messages: response.messages.map(toUniversalMessage),
			hasMore: response.hasMore,
			readThrough: response.readThrough,
			typingNames: response.typing ?? [],
		};
	},

	async markRead(conversation): Promise<void> {
		await api('/api/read', {
			method: 'POST',
			body: JSON.stringify({ conversationId: conversation.remoteId }),
		});
	},

	async getMessageDetails(_conversation, message): Promise<UniversalMessage> {
		return message;
	},

	async setTyping(conversation, active): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/typing', {
			method: 'POST',
			body: JSON.stringify({
				kind: conversation.kind,
				target,
				stop: !active,
			}),
		});
	},

	async sendText(conversation, text, replyTo): Promise<UniversalMessage> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		const response = await api<{ message: SignalMessage }>('/api/send', {
			method: 'POST',
			body: JSON.stringify({
				kind: conversation.kind,
				target,
				message: text,
				quoteTimestamp: replyTo?.sentAt,
			}),
		});
		return toUniversalMessage(response.message);
	},

	async react(conversation, message, emoji, remove = false): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/message/reaction', {
			method: 'POST',
			body: JSON.stringify({
				kind: conversation.kind,
				target,
				timestamp: message.sentAt,
				emoji,
				remove,
			}),
		});
	},

	async updateConversation(conversation, update): Promise<void> {
		if (update.archived !== undefined) {
			await api('/api/conversation/archive', {
				method: 'POST',
				body: JSON.stringify({ conversationId: conversation.remoteId, archived: update.archived }),
			});
		}
		if (update.favourite !== undefined) {
			await api('/api/conversation/favorite', {
				method: 'POST',
				body: JSON.stringify({ conversationId: conversation.remoteId, favorite: update.favourite }),
			});
		}
		if (update.muted !== undefined) {
			await api('/api/conversation/mute', {
				method: 'POST',
				body: JSON.stringify({ conversationId: conversation.remoteId, muted: update.muted }),
			});
		}
		if (update.expiration !== undefined) {
			const [, target] = conversation.remoteId.split(/:(.*)/s);
			await api('/api/conversation/expiration', {
				method: 'POST',
				body: JSON.stringify({ kind: conversation.kind, target, expiration: update.expiration }),
			});
		}
	},

	async searchMessages(query, conversation): Promise<UniversalSearchResult[]> {
		const parameters = new URLSearchParams({ q: query });
		if (conversation) parameters.set('conversationId', conversation.remoteId);
		const response = await api<{
			results: { id: string; conversationId: string; sender?: string; text?: string; timestamp: number }[];
		}>(`/api/search?${parameters}`);
		return response.results.map((result) => ({
			id: `signal:${result.id}`,
			conversationId: `signal:${result.conversationId}`,
			sender: result.sender ?? 'Someone',
			text: result.text ?? '',
			sentAt: result.timestamp,
		}));
	},

	createDirect(address, title): UniversalConversation {
		const target = address.trim();
		return {
			id: `signal:direct:${target}`,
			serviceId: 'signal',
			remoteId: `direct:${target}`,
			kind: 'direct',
			title: title?.trim() || target,
			isNoteToSelf: false,
			isArchived: false,
			isFavourite: false,
			isMuted: false,
			unreadCount: 0,
			typingNames: [],
			expiration: 0,
			isBlocked: false,
			isMessageRequest: false,
			isIdentityChanged: false,
			isInvited: false,
			members: [],
			adminIds: [],
			permissions: {},
		};
	},

	async createGroup(name, members): Promise<void> {
		await api('/api/group/create', {
			method: 'POST',
			body: JSON.stringify({ name, members }),
		});
	},

	async getSettings(): Promise<UniversalSettings> {
		const response = await api<{ settings: UniversalSettings }>('/api/settings');
		return response.settings;
	},

	async updateSettings(settings): Promise<UniversalSettings> {
		const response = await api<{ settings: UniversalSettings }>('/api/settings', {
			method: 'POST',
			body: JSON.stringify(settings),
		});
		return response.settings;
	},

	async sendAttachment(conversation, file, caption = ''): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		const parameters = new URLSearchParams({
			kind: conversation.kind,
			target,
			filename: file.name,
			caption,
		});
		const response = await fetch(`/api/attachment/send?${parameters}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${widgetToken()}`,
				'content-type': file.type || 'application/octet-stream',
			},
			body: file,
		});
		if (!response.ok) {
			throw new Error((await response.json().catch(() => ({}))).error ?? 'Attachment failed');
		}
	},

	async forwardMessage(message, target): Promise<void> {
		await api('/api/message/forward', {
			method: 'POST',
			body: JSON.stringify({
				messageId: message.id.replace(/^signal:/, ''),
				kind: target.kind,
				target: target.remoteId.replace(/^(direct|group):/, ''),
			}),
		});
	},

	async listStickers(): Promise<UniversalSticker[]> {
		const response = await api<{ stickers: UniversalSticker[] }>('/api/stickers');
		return response.stickers;
	},

	async sendSticker(conversation, sticker): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/sticker/send', {
			method: 'POST',
			body: JSON.stringify({
				kind: conversation.kind,
				target,
				packId: sticker.packId,
				stickerId: sticker.stickerId,
			}),
		});
	},

	async editMessage(conversation, message, text): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/message/edit', {
			method: 'POST',
			body: JSON.stringify({ kind: conversation.kind, target, timestamp: message.sentAt, message: text }),
		});
	},

	async deleteMessage(conversation, message): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/message/delete', {
			method: 'POST',
			body: JSON.stringify({ kind: conversation.kind, target, timestamp: message.sentAt }),
		});
	},

	async pinMessage(conversation, message, pinned): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/message/pin', {
			method: 'POST',
			body: JSON.stringify({ kind: conversation.kind, target, timestamp: message.sentAt, pinned }),
		});
	},

	async capabilities(): Promise<ServiceCapabilities> {
		const response = await api<{ capabilities?: Partial<ServiceCapabilities> }>('/api/status');
		return {
			reactions: true,
			edits: true,
			deletes: true,
			pins: Boolean(response.capabilities?.pins),
			polls: Boolean(response.capabilities?.polls),
			voiceNotes: Boolean(response.capabilities?.voiceNotes),
			viewOnce: true,
			groups: true,
			identities: true,
			blocking: true,
			messageRequests: true,
			disappearingMessages: true,
			search: true,
			compose: true,
			settings: true,
			attachments: true,
			forwarding: true,
			stickers: Boolean(response.capabilities?.stickers),
			muting: true,
		};
	},

	async listPinnedMessages(conversation): Promise<UniversalMessage[]> {
		const response = await api<{ pins: SignalMessage[] }>(
			`/api/pins/${encodeURIComponent(conversation.remoteId)}`,
		);
		return response.pins.map(toUniversalMessage);
	},

	async sendVoiceNote(conversation, recording): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		const response = await fetch(
			`/api/voice?kind=${conversation.kind}&target=${encodeURIComponent(target)}`,
			{
				method: 'POST',
				headers: { authorization: `Bearer ${widgetToken()}`, 'content-type': recording.type || 'audio/webm' },
				body: recording,
			},
		);
		if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? 'Voice note failed');
	},

	async createPoll(conversation, question, options, multiple): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/poll/create', {
			method: 'POST',
			body: JSON.stringify({ kind: conversation.kind, target, question, options, multiple }),
		});
	},

	async votePoll(conversation, message, options): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/poll/vote', {
			method: 'POST',
			body: JSON.stringify({ kind: conversation.kind, target, timestamp: message.sentAt, options }),
		});
	},

	async closePoll(conversation, message): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/poll/close', {
			method: 'POST',
			body: JSON.stringify({ kind: conversation.kind, target, timestamp: message.sentAt }),
		});
	},

	async setBlocked(conversation, blocked): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/conversation/block', {
			method: 'POST',
			body: JSON.stringify({ kind: conversation.kind, target, blocked }),
		});
	},

	async respondToMessageRequest(conversation, response): Promise<void> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/message-request', {
			method: 'POST',
			body: JSON.stringify({ kind: conversation.kind, target, type: response }),
		});
	},

	async updateGroup(conversation, changes): Promise<void> {
		const [, groupId] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/group/update', { method: 'POST', body: JSON.stringify({ groupId, ...changes }) });
	},

	async leaveGroup(conversation): Promise<void> {
		const [, groupId] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/group/leave', { method: 'POST', body: JSON.stringify({ groupId }) });
	},

	async openViewOnce(message): Promise<string> {
		const response = await api<{ url: string }>('/api/view-once/open', {
			method: 'POST',
			body: JSON.stringify({ messageId: message.id.replace(/^signal:/, '') }),
		});
		return response.url;
	},

	async getSafetyNumber(conversation): Promise<string> {
		const [, target] = conversation.remoteId.split(/:(.*)/s);
		const response = await api<{
			identities: { safetyNumber?: string; fingerprint?: string; identityKey?: string }[];
		}>(`/api/identity/${encodeURIComponent(target)}`);
		const identity = response.identities[0];
		return identity?.safetyNumber ?? identity?.fingerprint ?? identity?.identityKey ?? 'Unavailable';
	},

	async trustSafetyNumber(conversation, safetyNumber): Promise<void> {
		const [, recipient] = conversation.remoteId.split(/:(.*)/s);
		await api('/api/identity/trust', { method: 'POST', body: JSON.stringify({ recipient, safetyNumber }) });
	},
};
