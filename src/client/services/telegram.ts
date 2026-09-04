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

const ROOT = '/api/services/telegram';

type TelegramStatus = {
	ready: boolean;
	connected: boolean;
	configured: boolean;
	authStage: string;
	accountLabel?: string;
	passwordHint?: string;
	qr?: { url: string; image: string; expiresAt: number };
	error?: string;
};

type TelegramMessage = {
	id: string;
	telegramId: number;
	conversationId: string;
	direction: 'in' | 'out' | 'system';
	sender?: string;
	text?: string;
	timestamp: number;
	edited?: boolean;
	pinned?: boolean;
	deleted?: boolean;
	status?: 'sent' | 'delivered' | 'read';
	previews?: { title?: string; description?: string; url?: string }[];
	attachments?: {
		id?: string;
		contentType?: string;
		filename?: string;
		size?: number;
		width?: number;
		height?: number;
	}[];
	reactions?: { emoji: string; author?: string; authorId?: string; own?: boolean }[];
	quote?: { author?: string; text?: string; timestamp?: number };
	poll?: {
		question: string;
		options: { index: number; text: string; votes: string[] }[];
		multiple?: boolean;
		closed?: boolean;
	};
	forwardedFrom?: string;
	sticker?: { path?: boolean };
};

type TelegramConversation = {
	id: string;
	kind: 'direct' | 'group';
	target: string;
	name: string;
	noteToSelf?: boolean;
	archived?: boolean;
	favorite?: boolean;
	muted?: boolean;
	unread?: number;
	last?: TelegramMessage;
	typing?: string[];
	avatar?: string;
	expiration?: number;
	blocked?: boolean;
	description?: string;
	members?: { id: string; name: string }[];
	admins?: string[];
	permissions?: Record<string, string>;
};

type TelegramConversationResponse = {
	conversations: TelegramConversation[];
	archivedCount: number;
};

type TelegramMessageResponse = {
	messages: TelegramMessage[];
	hasMore: boolean;
	readThrough: number;
	typing?: string[];
	allowedReactions?: string[];
	conversation?: {
		description?: string;
		members?: { id: string; name: string }[];
		admins?: string[];
		inviteLink?: string;
		blocked?: boolean;
	};
};

function attachmentKind(contentType?: string): 'image' | 'video' | 'audio' | 'file' {
	if (contentType?.startsWith('image/')) return 'image';
	if (contentType?.startsWith('video/')) return 'video';
	if (contentType?.startsWith('audio/')) return 'audio';
	return 'file';
}

function messageFromTelegram(message: TelegramMessage): UniversalMessage {
	return {
		id: `telegram:${message.id}`,
		conversationId: `telegram:${message.conversationId}`,
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
			id: attachment.id ?? String(index),
			kind: attachmentKind(attachment.contentType),
			path: `${ROOT}/attachment/${encodeURIComponent(message.id)}/${index}`,
			contentType: attachment.contentType,
			filename: attachment.filename,
			size: attachment.size,
			width: attachment.width,
			height: attachment.height,
		})),
		reactions: (message.reactions ?? []).map((reaction) => ({
			emoji: reaction.emoji,
			author: reaction.author ?? 'Telegram user',
			isOwn: Boolean(reaction.own),
			avatarPath: reaction.authorId
				? `${ROOT}/avatar/${encodeURIComponent(reaction.authorId)}`
				: undefined,
		})),
		receipt: message.direction === 'out' ? { state: message.status ?? 'delivered' } : undefined,
		quote: message.quote?.author
			? { author: message.quote.author, text: message.quote.text, sentAt: message.quote.timestamp }
			: undefined,
		previews: message.previews?.map((preview) => ({
			title: preview.title ?? preview.url ?? 'Link',
			description: preview.description,
			url: preview.url,
		})),
		edited: message.edited,
		deleted: message.deleted,
		pinned: message.pinned,
		poll: message.poll
			? {
					...message.poll,
					multiple: Boolean(message.poll.multiple),
					closed: Boolean(message.poll.closed),
				}
			: undefined,
		stickerPath: message.sticker
			? `${ROOT}/attachment/${encodeURIComponent(message.id)}/0`
			: undefined,
		forwardedFrom: message.forwardedFrom,
	};
}

function conversationFromTelegram(conversation: TelegramConversation): UniversalConversation {
	return {
		id: `telegram:${conversation.id}`,
		serviceId: 'telegram',
		remoteId: conversation.id,
		kind: conversation.kind,
		title: conversation.name,
		isNoteToSelf: Boolean(conversation.noteToSelf),
		isArchived: Boolean(conversation.archived),
		isFavourite: Boolean(conversation.favorite),
		isMuted: Boolean(conversation.muted),
		unreadCount: conversation.unread ?? 0,
		typingNames: conversation.typing ?? [],
		avatarPath: conversation.avatar,
		lastMessage: conversation.last ? messageFromTelegram(conversation.last) : undefined,
		expiration: conversation.expiration ?? 0,
		isBlocked: Boolean(conversation.blocked),
		isMessageRequest: false,
		isIdentityChanged: false,
		isInvited: false,
		description: conversation.description,
		members: conversation.members ?? [],
		adminIds: conversation.admins ?? [],
		permissions: conversation.permissions ?? {},
	};
}

function targetOf(conversation: UniversalConversation) {
	return conversation.remoteId.split(':').at(-1) ?? conversation.remoteId;
}

function messageReference(conversation: UniversalConversation, message: UniversalMessage) {
	return {
		target: targetOf(conversation),
		messageId: Number(message.id.split(':').at(-1)),
		timestamp: message.sentAt,
	};
}

function completeStep(): ServiceSetupStep {
	return {
		kind: 'complete',
		title: 'Telegram connected',
		instructions: 'Your Telegram chats will now appear in the shared inbox.',
	};
}

function passwordStep(status: TelegramStatus, flow: 'qr' | 'phone'): ServiceSetupStep {
	return {
		kind: 'input',
		token: `${flow}-password`,
		title: 'Two-step verification',
		instructions: 'Enter your Telegram two-step verification password.',
		field: 'password',
		placeholder: 'Telegram password',
		hint: status.passwordHint ? `Hint: ${status.passwordHint}` : undefined,
	};
}

function statusToStep(status: TelegramStatus, flow: 'qr' | 'phone'): ServiceSetupStep {
	if (status.connected || status.authStage === 'authorized') return completeStep();
	if (status.authStage === 'password') return passwordStep(status, flow);
	throw new Error(status.error || 'Telegram sign-in did not complete');
}

export const telegramService: MessagingService = {
	id: 'telegram',
	label: 'Telegram',

	async getStatus() {
		const status = await api<TelegramStatus>(`${ROOT}/status`);
		return {
			id: 'telegram' as const,
			label: 'Telegram',
			ready: true,
			connected: status.connected,
			accountLabel: status.accountLabel,
		};
	},

	async beginSetup() {
		const status = await api<TelegramStatus>(`${ROOT}/status`);
		if (!status.configured) {
			return {
				kind: 'input' as const,
				token: 'telegram-api-id',
				title: 'Telegram API ID',
				instructions: 'Create an application at my.telegram.org, then enter its numeric API ID.',
				field: 'api-id' as const,
				placeholder: '12345678',
			};
		}
		return {
			kind: 'choice' as const,
			token: 'telegram-method',
			title: 'Connect Telegram',
			instructions: 'Choose how to sign in to your Telegram account.',
			choices: [
				{ value: 'qr', label: 'Scan QR', description: 'Approve from a signed-in Telegram device.' },
				{ value: 'phone', label: 'Phone number', description: 'Receive a code in Telegram.' },
			],
		};
	},

	async advanceSetup(step, value) {
		if (step.kind === 'input' && step.token === 'telegram-api-id') {
			if (!/^\d+$/.test(value ?? '')) throw new Error('Enter the numeric API ID from my.telegram.org');
			return {
				kind: 'input' as const,
				token: `telegram-api-hash:${value}`,
				title: 'Telegram API hash',
				instructions: 'Enter the API hash shown beside your API ID at my.telegram.org.',
				field: 'api-hash' as const,
				placeholder: '32-character hash',
			};
		}
		if (step.kind === 'input' && step.token.startsWith('telegram-api-hash:')) {
			const apiId = step.token.slice('telegram-api-hash:'.length);
			await api<TelegramStatus>(`${ROOT}/configure`, {
				method: 'POST',
				body: JSON.stringify({ apiId, apiHash: value }),
			});
			return {
				kind: 'choice' as const,
				token: 'telegram-method',
				title: 'Connect Telegram',
				instructions: 'Choose how to sign in to your Telegram account.',
				choices: [
					{ value: 'qr', label: 'Scan QR', description: 'Approve from a signed-in Telegram device.' },
					{ value: 'phone', label: 'Phone number', description: 'Receive a code in Telegram.' },
				],
			};
		}
		if (step.kind === 'choice') {
			if (value === 'phone') {
				return {
					kind: 'input' as const,
					token: 'phone',
					title: 'Phone number',
					instructions: 'Include the country code, for example +44.',
					field: 'phone' as const,
					placeholder: '+44…',
				};
			}
			const status = await api<TelegramStatus>(`${ROOT}/auth/qr/start`, { method: 'POST' });
			if (!status.qr) throw new Error('Telegram did not provide a QR code');
			return {
				kind: 'qr' as const,
				token: status.qr.url,
				title: 'Scan with Telegram',
				instructions: 'Telegram → Settings → Devices → Link Desktop Device',
				image: status.qr.image,
			};
		}

		if (step.kind === 'qr') {
			while (true) {
				const status = await api<TelegramStatus>(
					`${ROOT}/auth/qr/poll?token=${encodeURIComponent(step.token)}`,
				);
				if (status.connected || status.authStage !== 'qr') return statusToStep(status, 'qr');
				if (status.qr?.url && status.qr.url !== step.token) {
					return {
						...step,
						token: status.qr.url,
						image: status.qr.image,
					};
				}
			}
		}

		if (step.kind !== 'input') throw new Error('Unexpected Telegram setup step');
		if (step.field === 'phone') {
			const status = await api<TelegramStatus>(`${ROOT}/auth/phone`, {
				method: 'POST',
				body: JSON.stringify({ phone: value }),
			});
			if (status.connected) return completeStep();
			return {
				kind: 'input' as const,
				token: 'code',
				title: 'Telegram code',
				instructions: 'Enter the code Telegram sent to one of your signed-in devices.',
				field: 'code' as const,
				placeholder: 'Login code',
			};
		}
		if (step.field === 'code') {
			const status = await api<TelegramStatus>(`${ROOT}/auth/code`, {
				method: 'POST',
				body: JSON.stringify({ code: value }),
			});
			return status.connected ? completeStep() : statusToStep(status, 'phone');
		}
		const status = await api<TelegramStatus>(`${ROOT}/auth/password`, {
			method: 'POST',
			body: JSON.stringify({ password: value }),
		});
		return statusToStep(status, step.token.startsWith('qr') ? 'qr' : 'phone');
	},

	async disconnect() {
		await api(`${ROOT}/disconnect`, { method: 'POST' });
	},

	async listConversations({ archived }): Promise<ConversationPage> {
		const response = await api<TelegramConversationResponse>(
			`${ROOT}/conversations${archived ? '?archived=1' : ''}`,
		);
		return {
			conversations: response.conversations.map(conversationFromTelegram),
			archivedCount: response.archivedCount,
		};
	},

	async listMessages(conversation, { before } = {}): Promise<MessagePage> {
		const query = before ? `?before=${before}` : '';
		const response = await api<TelegramMessageResponse>(
			`${ROOT}/messages/${encodeURIComponent(conversation.remoteId)}${query}`,
		);
		return {
			messages: response.messages.map(messageFromTelegram),
			hasMore: response.hasMore,
			readThrough: response.readThrough,
			typingNames: response.typing ?? [],
			allowedReactions: response.allowedReactions,
			conversation: response.conversation
				? {
					description: response.conversation.description,
					members: response.conversation.members,
					adminIds: response.conversation.admins,
					inviteLink: response.conversation.inviteLink,
					isBlocked: response.conversation.blocked,
				}
				: undefined,
		};
	},

	async markRead(conversation) {
		await api(`${ROOT}/read`, {
			method: 'POST',
			body: JSON.stringify({ conversationId: conversation.remoteId }),
		});
	},

	async getMessageDetails(conversation, message) {
		if (conversation.kind !== 'group' || message.direction !== 'outgoing') return message;
		const reference = messageReference(conversation, message);
		const response = await api<{
			readBy: { name: string; at: number }[];
		}>(
			`${ROOT}/receipt?target=${encodeURIComponent(reference.target)}&messageId=${reference.messageId}`,
		);
		return {
			...message,
			receipt: {
				state: response.readBy.length ? 'read' : (message.receipt?.state ?? 'delivered'),
				readBy: response.readBy.map((receipt) => ({
					name: receipt.name,
					status: 'read',
					at: receipt.at,
				})),
			},
		};
	},

	async setTyping(conversation, active) {
		await api(`${ROOT}/typing`, {
			method: 'POST',
			body: JSON.stringify({ target: targetOf(conversation), stop: !active }),
		});
	},

	async sendText(conversation, text, replyTo) {
		const response = await api<{ message: TelegramMessage }>(`${ROOT}/send`, {
			method: 'POST',
			body: JSON.stringify({
				target: targetOf(conversation),
				message: text,
				quoteTimestamp: replyTo?.sentAt,
			}),
		});
		return messageFromTelegram(response.message);
	},

	async react(conversation, message, emoji, remove = false) {
		await api(`${ROOT}/reaction`, {
			method: 'POST',
			body: JSON.stringify({ ...messageReference(conversation, message), emoji, remove }),
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
		return response.results.map((result) => ({
			id: `telegram:${result.conversationId}:${result.timestamp}`,
			conversationId: `telegram:${result.conversationId}`,
			sender: result.sender,
			text: result.text,
			sentAt: result.timestamp,
		}));
	},

	createDirect(address, title): UniversalConversation {
		return {
			id: `telegram:direct:${address}`,
			serviceId: 'telegram',
			remoteId: `direct:${address}`,
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
		const parameters = new URLSearchParams({
			target: targetOf(conversation),
			filename: file.name,
			caption,
		});
		const response = await fetch(`${ROOT}/attachment/send?${parameters}`, {
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

	async forwardMessage(message, target) {
		await api(`${ROOT}/forward`, {
			method: 'POST',
			body: JSON.stringify({
				fromTarget: message.conversationId.split(':').at(-1),
				messageId: Number(message.id.split(':').at(-1)),
				target: targetOf(target),
			}),
		});
	},

	async listStickers() {
		return [];
	},

	async sendSticker() {
		throw new Error('Telegram sticker sending is not available yet');
	},

	async editMessage(conversation, message, text) {
		await api(`${ROOT}/edit`, {
			method: 'POST',
			body: JSON.stringify({ ...messageReference(conversation, message), message: text }),
		});
	},

	async deleteMessage(conversation, message) {
		await api(`${ROOT}/delete`, {
			method: 'POST',
			body: JSON.stringify(messageReference(conversation, message)),
		});
	},

	async pinMessage(conversation, message, pinned) {
		await api(`${ROOT}/pin`, {
			method: 'POST',
			body: JSON.stringify({ ...messageReference(conversation, message), pinned }),
		});
	},

	async capabilities(): Promise<ServiceCapabilities> {
		return {
			reactions: true,
			edits: true,
			deletes: true,
			pins: true,
			polls: true,
			voiceNotes: true,
			viewOnce: false,
			groups: true,
			identities: false,
			blocking: true,
			messageRequests: false,
			disappearingMessages: true,
			search: true,
			compose: true,
			settings: true,
			attachments: true,
			forwarding: true,
			stickers: false,
			muting: true,
			disappearingDurations: [0, 86_400, 604_800, 2_592_000],
		};
	},

	async listPinnedMessages(conversation) {
		const response = await api<{ pins: TelegramMessage[] }>(
			`${ROOT}/pins/${encodeURIComponent(conversation.remoteId)}`,
		);
		return response.pins.map(messageFromTelegram);
	},

	async sendVoiceNote(conversation, recording) {
		const response = await fetch(`${ROOT}/voice?target=${encodeURIComponent(targetOf(conversation))}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${widgetToken()}`,
				'content-type': recording.type || 'audio/webm',
			},
			body: recording,
		});
		if (!response.ok) {
			throw new Error((await response.json().catch(() => ({}))).error ?? 'Voice note failed');
		}
	},

	async createPoll(conversation, question, options, multiple) {
		await api(`${ROOT}/poll/create`, {
			method: 'POST',
			body: JSON.stringify({ target: targetOf(conversation), question, options, multiple }),
		});
	},

	async votePoll(conversation, message, options) {
		await api(`${ROOT}/poll/vote`, {
			method: 'POST',
			body: JSON.stringify({ ...messageReference(conversation, message), options }),
		});
	},

	async closePoll(conversation, message) {
		await api(`${ROOT}/poll/close`, {
			method: 'POST',
			body: JSON.stringify(messageReference(conversation, message)),
		});
	},

	async setBlocked(conversation, blocked) {
		await api(`${ROOT}/block`, {
			method: 'POST',
			body: JSON.stringify({ target: targetOf(conversation), blocked }),
		});
	},

	async respondToMessageRequest() {
		throw new Error('Telegram does not use Signal message requests');
	},

	async updateGroup(conversation, changes) {
		await api(`${ROOT}/group/update`, {
			method: 'POST',
			body: JSON.stringify({ target: targetOf(conversation), ...changes }),
		});
	},

	async leaveGroup(conversation) {
		await api(`${ROOT}/group/leave`, {
			method: 'POST',
			body: JSON.stringify({ target: targetOf(conversation) }),
		});
	},

	async openViewOnce() {
		throw new Error('Telegram view-once media is not exposed here');
	},

	async getSafetyNumber() {
		throw new Error('Telegram does not have Signal safety numbers');
	},

	async trustSafetyNumber() {
		throw new Error('Telegram does not have Signal safety numbers');
	},
};
