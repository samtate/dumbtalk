export type ServiceId = 'signal' | 'telegram' | 'whatsapp';

export type ServiceStatus = {
	id: ServiceId;
	label: string;
	connected: boolean;
	ready: boolean;
	accountLabel?: string;
};

export type ServiceSetupStep =
	| {
			kind: 'choice';
			token: string;
			title: string;
			instructions: string;
			choices: { value: string; label: string; description?: string }[];
	  }
	| {
			kind: 'qr';
			token: string;
			title: string;
			instructions: string;
			image: string;
	  }
	| {
			kind: 'pair-code';
			token: string;
			title: string;
			instructions: string;
			code: string;
			phone: string;
	  }
	| {
			kind: 'input';
			token: string;
			title: string;
			instructions: string;
			field: 'phone' | 'code' | 'password' | 'api-id' | 'api-hash';
			placeholder?: string;
			hint?: string;
	  }
	| {
			kind: 'complete';
			title: string;
			instructions: string;
	  };

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

export type UniversalAttachment = {
	id: string;
	kind: AttachmentKind;
	path?: string;
	contentType?: string;
	filename?: string;
	size?: number;
	caption?: string;
	width?: number;
	height?: number;
};

export type UniversalQuote = {
	author: string;
	text?: string;
	sentAt?: number;
};

export type UniversalLinkPreview = {
	title: string;
	description?: string;
	url?: string;
};

export type UniversalPoll = {
	question: string;
	options: { index: number; text: string; votes: string[] }[];
	multiple: boolean;
	closed: boolean;
};

export type ServiceCapabilities = {
	reactions: boolean;
	edits: boolean;
	deletes: boolean;
	pins: boolean;
	polls: boolean;
	voiceNotes: boolean;
	viewOnce: boolean;
	groups: boolean;
	identities: boolean;
	blocking: boolean;
	messageRequests: boolean;
	disappearingMessages: boolean;
	search: boolean;
	compose: boolean;
	settings: boolean;
	attachments: boolean;
	forwarding: boolean;
	stickers: boolean;
	muting: boolean;
	disappearingDurations?: number[];
};

export type UniversalSettings = {
	sendReadReceipts: boolean;
	sendTypingIndicators: boolean;
	linkPreviews: boolean;
	defaultExpiration: number;
};

export type UniversalSearchResult = {
	id: string;
	conversationId: string;
	sender: string;
	text: string;
	sentAt: number;
};

export type UniversalSticker = {
	id: string;
	packId: string;
	stickerId: string;
	emoji?: string;
	packTitle?: string;
	path: string;
};

export type UniversalReceipt = {
	state: 'sent' | 'delivered' | 'read';
	updatedAt?: number;
	readBy?: { name: string; status: 'delivered' | 'read' | 'viewed'; at?: number }[];
};

export type UniversalReaction = {
	emoji: string;
	author: string;
	isOwn: boolean;
	avatarPath?: string;
};

export type UniversalMessage = {
	id: string;
	conversationId: string;
	sentAt: number;
	direction: 'incoming' | 'outgoing' | 'system';
	sender?: string;
	text?: string;
	attachments: UniversalAttachment[];
	reactions: UniversalReaction[];
	receipt?: UniversalReceipt;
	quote?: UniversalQuote;
	edited?: boolean;
	deleted?: boolean;
	pinned?: boolean;
	poll?: UniversalPoll;
	viewOnce?: { opened: boolean };
	previews?: UniversalLinkPreview[];
	stickerPath?: string;
	forwardedFrom?: string;
};

export type ConversationMember = {
	id: string;
	name: string;
};

export type UniversalConversation = {
	id: string;
	serviceId: ServiceId;
	remoteId: string;
	kind: 'direct' | 'group';
	title: string;
	isNoteToSelf: boolean;
	isArchived: boolean;
	isFavourite: boolean;
	isMuted: boolean;
	unreadCount: number;
	typingNames: string[];
	avatarPath?: string;
	lastMessage?: UniversalMessage;
	expiration: number;
	isBlocked: boolean;
	isMessageRequest: boolean;
	isIdentityChanged: boolean;
	isInvited: boolean;
	description?: string;
	members: ConversationMember[];
	adminIds: string[];
	inviteLink?: string;
	permissions: Record<string, string>;
};

export type ConversationPage = {
	conversations: UniversalConversation[];
	archivedCount: number;
};

export type MessagePage = {
	messages: UniversalMessage[];
	hasMore: boolean;
	readThrough: number;
	typingNames: string[];
	allowedReactions?: string[];
	conversation?: Partial<UniversalConversation>;
};

export type MessagingService = {
	id: ServiceId;
	label: string;
	getStatus: () => Promise<ServiceStatus>;
	beginSetup: () => Promise<ServiceSetupStep>;
	advanceSetup: (step: ServiceSetupStep, value?: string) => Promise<ServiceSetupStep>;
	disconnect: () => Promise<void>;
	listConversations: (options: { archived: boolean }) => Promise<ConversationPage>;
	listMessages: (conversation: UniversalConversation, options?: { before?: number }) => Promise<MessagePage>;
	markRead: (conversation: UniversalConversation) => Promise<void>;
	getMessageDetails: (
		conversation: UniversalConversation,
		message: UniversalMessage,
	) => Promise<UniversalMessage>;
	setTyping: (conversation: UniversalConversation, active: boolean) => Promise<void>;
	sendText: (
		conversation: UniversalConversation,
		text: string,
		replyTo?: UniversalMessage,
	) => Promise<UniversalMessage>;
	react: (
		conversation: UniversalConversation,
		message: UniversalMessage,
		emoji: string,
		remove?: boolean,
	) => Promise<void>;
	updateConversation: (
		conversation: UniversalConversation,
		update: { archived?: boolean; favourite?: boolean; muted?: boolean; expiration?: number },
	) => Promise<void>;
	searchMessages: (
		query: string,
		conversation?: UniversalConversation,
	) => Promise<UniversalSearchResult[]>;
	createDirect: (address: string, title?: string) => UniversalConversation;
	createGroup: (name: string, members: string[]) => Promise<void>;
	getSettings: () => Promise<UniversalSettings>;
	updateSettings: (settings: UniversalSettings) => Promise<UniversalSettings>;
	sendAttachment: (
		conversation: UniversalConversation,
		file: File,
		caption?: string,
	) => Promise<void>;
	forwardMessage: (
		message: UniversalMessage,
		target: UniversalConversation,
	) => Promise<void>;
	listStickers: () => Promise<UniversalSticker[]>;
	sendSticker: (conversation: UniversalConversation, sticker: UniversalSticker) => Promise<void>;
	editMessage: (
		conversation: UniversalConversation,
		message: UniversalMessage,
		text: string,
	) => Promise<void>;
	deleteMessage: (conversation: UniversalConversation, message: UniversalMessage) => Promise<void>;
	pinMessage: (
		conversation: UniversalConversation,
		message: UniversalMessage,
		pinned: boolean,
	) => Promise<void>;
	capabilities: () => Promise<ServiceCapabilities>;
	listPinnedMessages: (conversation: UniversalConversation) => Promise<UniversalMessage[]>;
	sendVoiceNote: (conversation: UniversalConversation, recording: Blob) => Promise<void>;
	createPoll: (
		conversation: UniversalConversation,
		question: string,
		options: string[],
		multiple: boolean,
	) => Promise<void>;
	votePoll: (
		conversation: UniversalConversation,
		message: UniversalMessage,
		options: number[],
	) => Promise<void>;
	closePoll: (conversation: UniversalConversation, message: UniversalMessage) => Promise<void>;
	setBlocked: (conversation: UniversalConversation, blocked: boolean) => Promise<void>;
	respondToMessageRequest: (
		conversation: UniversalConversation,
		response: 'accept' | 'delete',
	) => Promise<void>;
	updateGroup: (conversation: UniversalConversation, changes: Record<string, unknown>) => Promise<void>;
	leaveGroup: (conversation: UniversalConversation) => Promise<void>;
	openViewOnce: (message: UniversalMessage) => Promise<string>;
	getSafetyNumber: (conversation: UniversalConversation) => Promise<string>;
	trustSafetyNumber: (conversation: UniversalConversation, safetyNumber: string) => Promise<void>;
};
