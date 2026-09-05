import { api, widgetToken } from '../api/client';
import type {
	ConversationPage,
	MessagePage,
	MessagingService,
	ServiceCapabilities,
	ServiceSetupStep,
	UniversalConversation,
	UniversalMessage,
	UniversalSearchResult,
	UniversalSettings,
} from './contracts';

const ROOT = '/api/services/whatsapp';

type WhatsAppStatus = {
	ready: boolean;
	connected: boolean;
	authStage: string;
	accountLabel?: string;
	qr?: { url: string; image: string };
	pairCode?: { code: string; phone: string };
	error?: string;
};

type WhatsAppAttachment = {
	id: string;
	kind: 'image' | 'video' | 'audio' | 'file';
	contentType?: string;
	filename?: string;
};

type WhatsAppMessage = {
	id: string;
	conversationId: string;
	direction: 'in' | 'out' | 'system';
	sender?: string;
	senderId?: string;
	text?: string;
	timestamp: number;
	edited?: boolean;
	deleted?: boolean;
	forwardedFrom?: string;
	attachments?: WhatsAppAttachment[];
	status?: 'sent' | 'delivered' | 'read';
	receipt?: {
		state: 'delivered' | 'read';
		at?: number;
		recipients?: Record<string, { state: 'delivered' | 'read'; at?: number }>;
	};
	reactions?: { emoji: string; author: string; own: boolean }[];
	poll?: {
		question: string;
		options: { index: number; text: string; votes: string[] }[];
		multiple: boolean;
		closed: boolean;
	};
};

type WhatsAppConversation = {
	id: string;
	kind: 'direct' | 'group';
	target: string;
	name: string;
	archived?: boolean;
	favorite?: boolean;
	muted?: boolean;
	unread?: number;
	last?: WhatsAppMessage;
	typing?: string[];
};

function messageFromWhatsApp(message: WhatsAppMessage): UniversalMessage {
	return {
		id: `whatsapp:${message.id}`,
		conversationId: `whatsapp:${message.conversationId}`,
		sentAt: message.timestamp,
		direction:
			message.direction === 'in'
				? 'incoming'
				: message.direction === 'out'
					? 'outgoing'
					: 'system',
		sender: message.sender,
		text: message.text,
		attachments: (message.attachments ?? []).map((attachment, index) => ({
			id: attachment.id || String(index),
			kind: attachment.kind,
			path: `${ROOT}/attachment/${encodeURIComponent(message.conversationId)}/${encodeURIComponent(message.id)}`,
			contentType: attachment.contentType,
			filename: attachment.filename,
		})),
		reactions: (message.reactions ?? []).map((reaction) => ({
			emoji: reaction.emoji,
			author: reaction.author,
			isOwn: reaction.own,
		})),
		receipt:
			message.direction === 'out'
				? {
						state: message.status ?? 'sent',
						updatedAt: message.receipt?.at,
						readBy: Object.entries(message.receipt?.recipients ?? {}).map(([name, receipt]) => ({
							name,
							status: receipt.state,
							at: receipt.at,
						})),
					}
				: undefined,
		edited: message.edited,
		deleted: message.deleted,
		forwardedFrom: message.forwardedFrom,
		poll: message.poll,
	};
}

function conversationFromWhatsApp(conversation: WhatsAppConversation): UniversalConversation {
	return {
		id: `whatsapp:${conversation.id}`,
		serviceId: 'whatsapp',
		remoteId: conversation.id,
		kind: conversation.kind,
		title: conversation.name,
		isNoteToSelf: false,
		isArchived: Boolean(conversation.archived),
		isFavourite: Boolean(conversation.favorite),
		isMuted: Boolean(conversation.muted),
		unreadCount: conversation.unread ?? 0,
		typingNames: conversation.typing ?? [],
		lastMessage: conversation.last ? messageFromWhatsApp(conversation.last) : undefined,
		expiration: 0,
		isBlocked: false,
		isMessageRequest: false,
		isIdentityChanged: false,
		isInvited: false,
		members: [],
		adminIds: [],
		permissions: {},
	};
}

function messageId(message: UniversalMessage) {
	return message.id.slice('whatsapp:'.length);
}

function unsupported(feature: string): never {
	throw new Error(`${feature} is not available for WhatsApp yet`);
}

const capabilities: ServiceCapabilities = {
	reactions: true,
	edits: true,
	deletes: true,
	pins: false,
	polls: true,
	voiceNotes: false,
	viewOnce: false,
	groups: true,
	identities: false,
	blocking: false,
	messageRequests: false,
	disappearingMessages: false,
	search: true,
	compose: true,
	settings: true,
	attachments: true,
	forwarding: true,
	stickers: false,
	muting: true,
};

export const whatsappService: MessagingService = {
	id: 'whatsapp',
	label: 'WhatsApp',

	async getStatus() {
		const status = await api<WhatsAppStatus>(`${ROOT}/status`);
		return {
			id: 'whatsapp',
			label: 'WhatsApp',
			ready: status.ready,
			connected: status.connected,
			accountLabel: status.accountLabel,
		};
	},

	async beginSetup() {
		return {
			kind: 'choice',
			token: 'whatsapp-link-method',
			title: 'Link WhatsApp',
			instructions: 'Choose how to pair this linked device.',
			choices: [
				{ value: 'qr', label: 'Scan QR', description: 'Use WhatsApp → Linked devices → Link a device.' },
				{ value: 'phone', label: 'Use linking code', description: 'Enter a short code on your phone instead.' },
			],
		};
	},

	async advanceSetup(step, input) {
		if (step.kind === 'choice') {
			if (input === 'phone') {
				return {
					kind: 'input', token: 'whatsapp-phone', title: 'Phone number',
					instructions: 'Enter the WhatsApp number, including country code.', field: 'phone', placeholder: '+44…',
				};
			}
			const status = await api<WhatsAppStatus>(`${ROOT}/auth/qr/start`, { method: 'POST' });
			return setupStep(status);
		}
		if (step.kind === 'input' && step.token === 'whatsapp-phone') {
			const status = await api<WhatsAppStatus>(`${ROOT}/auth/phone/start`, { method: 'POST', body: JSON.stringify({ phone: input }) });
			return setupStep(status);
		}
		if (step.kind !== 'qr' && step.kind !== 'pair-code') throw new Error('Unexpected WhatsApp setup step');
		const status = await api<WhatsAppStatus>(`${ROOT}/auth/qr/poll`);
		if (status.connected) return setupStep(status);
		if (status.qr && status.qr.url !== step.token) {
			return setupStep(status);
		}
		if (status.error) throw new Error(status.error);
		return step;
	},

	async disconnect() {
		await api(`${ROOT}/disconnect`, { method: 'POST' });
	},

	async listConversations({ archived }): Promise<ConversationPage> {
		const response = await api<{ conversations: WhatsAppConversation[]; archivedCount: number }>(
			`${ROOT}/conversations${archived ? '?archived=1' : ''}`,
		);
		return {
			conversations: response.conversations.map(conversationFromWhatsApp),
			archivedCount: response.archivedCount,
		};
	},

	async listMessages(conversation, { before } = {}): Promise<MessagePage> {
		const query = before ? `?before=${before}` : '';
		const response = await api<{
			messages: WhatsAppMessage[];
			hasMore: boolean;
			readThrough: number;
			typing: string[];
		}>(`${ROOT}/messages/${encodeURIComponent(conversation.remoteId)}${query}`);
		return {
			messages: response.messages.map(messageFromWhatsApp),
			hasMore: response.hasMore,
			readThrough: response.readThrough,
			typingNames: response.typing,
		};
	},

	async markRead(conversation) {
		await api(`${ROOT}/read`, {
			method: 'POST',
			body: JSON.stringify({ conversationId: conversation.remoteId }),
		});
	},

	async getMessageDetails(_conversation, message) {
		return message;
	},

	async setTyping(conversation, active) {
		await api(`${ROOT}/typing`, {
			method: 'POST',
			body: JSON.stringify({ conversationId: conversation.remoteId, active }),
		});
	},

	async sendText(conversation, text, replyTo) {
		const response = await api<{ message: WhatsAppMessage }>(`${ROOT}/send`, {
			method: 'POST',
			body: JSON.stringify({
				target: conversation.remoteId,
				message: text,
				replyToId: replyTo ? messageId(replyTo) : undefined,
			}),
		});
		return messageFromWhatsApp(response.message);
	},

	async react(conversation, message, emoji, remove = false) {
		await api(`${ROOT}/reaction`, {
			method: 'POST',
			body: JSON.stringify({
				target: conversation.remoteId,
				messageId: messageId(message),
				emoji,
				remove,
			}),
		});
	},

	async updateConversation(conversation, update) {
		await api(`${ROOT}/conversation`, {
			method: 'POST',
			body: JSON.stringify({ conversationId: conversation.remoteId, ...update }),
		});
	},

	async searchMessages(query): Promise<UniversalSearchResult[]> {
		const response = await api<{
			results: { conversationId: string; timestamp: number; sender: string; text: string }[];
		}>(`${ROOT}/search?q=${encodeURIComponent(query)}`);
		return response.results.map(result => ({
			id: `whatsapp:${result.conversationId}:${result.timestamp}`,
			conversationId: `whatsapp:${result.conversationId}`,
			sender: result.sender,
			text: result.text,
			sentAt: result.timestamp,
		}));
	},

	createDirect(address, title) {
		return {
			id: `whatsapp:direct:${address}`,
			serviceId: 'whatsapp',
			remoteId: address,
			kind: 'direct',
			title: title || address,
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

	async createGroup(name, members) {
		await api(`${ROOT}/group/create`, {
			method: 'POST',
			body: JSON.stringify({ name, members }),
		});
	},

	async getSettings() {
		return (await api<{ settings: UniversalSettings }>(`${ROOT}/settings`)).settings;
	},

	async updateSettings(settings) {
		return (
			await api<{ settings: UniversalSettings }>(`${ROOT}/settings`, {
				method: 'POST',
				body: JSON.stringify(settings),
			})
		).settings;
	},

	async sendAttachment(conversation, file, caption = '') {
		const query = new URLSearchParams({
			target: conversation.remoteId,
			filename: file.name,
			caption,
		});
		const response = await fetch(`${ROOT}/attachment/send?${query}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${widgetToken()}`,
				'content-type': file.type || 'application/octet-stream',
			},
			body: file,
		});
		if (!response.ok) {
			throw new Error((await response.json().catch(() => ({}))).error || 'Attachment failed');
		}
	},

	async forwardMessage(message, target) {
		await api(`${ROOT}/forward`, {
			method: 'POST',
			body: JSON.stringify({
				fromTarget: message.conversationId.slice('whatsapp:'.length),
				messageId: messageId(message),
				target: target.remoteId,
			}),
		});
	},
	async listStickers() { return []; },
	async sendSticker() { unsupported('Stickers'); },
	async editMessage(conversation, message, text) {
		await api(`${ROOT}/edit`, {
			method: 'POST',
			body: JSON.stringify({ target: conversation.remoteId, messageId: messageId(message), message: text }),
		});
	},
	async deleteMessage(conversation, message) {
		await api(`${ROOT}/delete`, {
			method: 'POST',
			body: JSON.stringify({ target: conversation.remoteId, messageId: messageId(message) }),
		});
	},
	async pinMessage() { unsupported('Pinning messages'); },
	async capabilities() { return capabilities; },
	async listPinnedMessages() { return []; },
	async sendVoiceNote() { unsupported('Voice notes'); },
	async createPoll(conversation, question, options, multiple) {
		await api(`${ROOT}/poll/create`, {
			method: 'POST',
			body: JSON.stringify({ target: conversation.remoteId, question, options, multiple }),
		});
	},
	async votePoll(conversation, message, options) {
		await api(`${ROOT}/poll/vote`, {
			method: 'POST',
			body: JSON.stringify({ target: conversation.remoteId, messageId: messageId(message), options }),
		});
	},
	async closePoll() { unsupported('Polls'); },
	async setBlocked() { unsupported('Blocking contacts'); },
	async respondToMessageRequest() { unsupported('Message requests'); },
	async updateGroup(conversation, changes) {
		await api(`${ROOT}/group/update`, {
			method: 'POST',
			body: JSON.stringify({ target: conversation.remoteId, ...changes }),
		});
	},
	async leaveGroup(conversation) {
		await api(`${ROOT}/group/leave`, {
			method: 'POST',
			body: JSON.stringify({ target: conversation.remoteId }),
		});
	},
	async openViewOnce() { unsupported('View-once media'); },
	async getSafetyNumber() { unsupported('Safety numbers'); },
	async trustSafetyNumber() { unsupported('Safety numbers'); },
};

function setupStep(status: WhatsAppStatus): ServiceSetupStep {
	if (status.connected) return { kind: 'complete', title: 'WhatsApp connected', instructions: 'Your WhatsApp chats will now appear in the shared inbox.' };
	if (status.pairCode) return {
		kind: 'pair-code', token: status.pairCode.code, code: status.pairCode.code, phone: status.pairCode.phone,
		title: 'Enter linking code', instructions: 'WhatsApp → Linked devices → Link a device → Link with phone number.',
	};
	if (status.qr) return { kind: 'qr', token: status.qr.url, title: 'Link WhatsApp', instructions: 'WhatsApp → Settings → Linked devices → Link a device', image: status.qr.image };
	throw new Error(status.error || 'WhatsApp did not provide a linking code');
}
