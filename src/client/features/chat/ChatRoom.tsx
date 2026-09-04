import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { FocusButton } from '../../components/FocusButton';
import { FocusInput } from '../../components/FocusInput';
import { AppIcon } from '../../components/AppIcon';
import { ChatOptions } from './ChatOptions';
import {
	GroupSettings,
	LocalNicknameEditor,
	PinnedMessages,
	PollComposer,
	SafetyNumber,
	VoiceComposer,
} from './ChatOptionScreens';
import { MediaViewer } from './MessageMedia';
import {
	AttachmentComposer,
	ChatSearch,
	ConversationPicker,
	StickerPicker,
} from './ChatUtilities';
import { attachmentLabel, MessageBubble } from './MessageBubble';
import { readMessagePage, writeMessagePage } from '../../cache/snapshots';
import { useFocusManager, type ArrowKey } from '../../platform/Focus';
import { useSoftkeys } from '../../platform/Softkeys';
import { useMessagingServices } from '../../services/ServiceContext';
import { api, widgetToken } from '../../api/client';
import type {
	MessagePage,
	ServiceCapabilities,
	UniversalConversation,
	UniversalMessage,
	UniversalSearchResult,
} from '../../services/contracts';
import styles from './ChatRoom.module.scss';

type Props = {
	conversation: UniversalConversation;
	initialMessage?: UniversalSearchResult;
	onBack: () => void;
};

type Anchor = {
	id: string;
	top: number;
};

function MessageActions({
	message,
	capabilities,
	onReply,
	onReact,
	onEdit,
	onDelete,
	onPin,
	onForward,
	expanded,
	onToggleExpanded,
	onVote,
	onClosePoll,
	favouriteReactions,
	allowedReactions,
}: {
	message: UniversalMessage;
	capabilities?: ServiceCapabilities;
	onReply: () => void;
	onReact: (emoji: string) => void;
	onEdit: () => void;
	onDelete: () => void;
	onPin: () => void;
	onForward: () => void;
	expanded: boolean;
	onToggleExpanded: () => void;
	onVote: (options: number[]) => void;
	onClosePoll: () => void;
	favouriteReactions: string[];
	allowedReactions?: string[];
}) {
	const detailsRef = useRef<HTMLButtonElement>(null);
	const reactions = expanded
		? [
				'👍',
				'❤️',
				'😂',
				'😮',
				'😢',
				'🙏',
				'🔥',
				'🎉',
				'😎',
				'🤔',
				'👏',
				'👎',
				'💯',
				'😡',
				'😱',
				'🥳',
				'💔',
				'✅',
				'😀',
				'😃',
				'😄',
				'😁',
				'😆',
				'🥹',
				'😊',
				'🙂',
				'🙃',
				'😉',
				'😍',
				'😘',
				'😋',
				'😛',
				'🤪',
				'🤨',
				'🧐',
				'🤓',
				'🥸',
				'🤩',
				'🥶',
				'🥵',
				'🤯',
				'😴',
				'🤢',
				'🤮',
				'🤧',
				'😇',
				'🤠',
				'🤑',
				'🤗',
				'🤭',
				'🫣',
				'🤫',
				'🫡',
				'🤐',
				'😐',
				'🙄',
				'😬',
				'😔',
				'😭',
				'😤',
				'🤬',
				'😈',
				'👻',
				'💩',
				'🤡',
				'👽',
				'🤖',
				'🐶',
				'🐱',
				'🐭',
				'🐹',
				'🐰',
				'🦊',
				'🐻',
				'🐼',
				'🐨',
				'🐯',
				'🦁',
				'🐸',
				'🐵',
				'🙈',
				'🙉',
				'🙊',
				'🐔',
				'🐧',
				'🐦',
				'🦄',
				'🐝',
				'🦋',
				'🌻',
				'🌈',
				'☀️',
				'⭐',
				'🌙',
				'🍏',
				'🍓',
				'🍕',
				'🍔',
				'🍟',
				'🍰',
				'☕',
				'🍺',
				'🥂',
				'⚽',
				'🎮',
				'🎵',
				'🚀',
				'🏠',
				'☎️',
				'💡',
				'🎁',
				'💬',
				'💤',
				'💀',
				'💪',
				'✌️',
				'🤞',
				'🫶',
				'🤟',
				'🤘',
				'👌',
				'🤌',
				'🫵',
				'👋',
			]
		: ['👍', '❤️', '😂', '😮', '😢', '🙏'];
	const availableReactions = allowedReactions ?? reactions;
	const canReact = capabilities?.reactions !== false && availableReactions.length > 0;
	const visibleReactions = expanded
		? availableReactions
		: reactions.filter((emoji) => availableReactions.includes(emoji)).slice(0, 6);
	const [pollChoices, setPollChoices] = useState<number[]>([]);

	if (expanded) {
		return (
			<main class={styles.actionScreen}>
				<header class={styles.header}>Choose reaction</header>
				<section class={styles.reactionPicker}>
					{visibleReactions.map((emoji) => (
						<FocusButton
							id={`message-all-reaction-${emoji}`}
							grid="all-reactions"
							columns={6}
							type="button"
							class={styles.reaction}
							onClick={() => onReact(emoji)}
						>
							{emoji}
						</FocusButton>
					))}
				</section>
			</main>
		);
	}

	return (
		<main class={styles.actionScreen}>
			<header class={styles.header}>Message</header>
			<section class={styles.actionList}>
				<FocusButton
					id="message-action-summary"
					type="button"
					class={styles.actionSummary}
					onClick={() => undefined}
				>
					<strong>{message.direction === 'outgoing' ? 'You' : (message.sender ?? 'Message')}</strong>
					{message.text || attachmentLabel(message) || 'Message'}
				</FocusButton>
				{canReact && <p class={styles.actionHeading}>Quick reaction</p>}
				{canReact && (
					<div class={styles.reactionGrid}>
						{visibleReactions.map((emoji) => (
							<FocusButton
								id={`message-reaction-${emoji}`}
								grid="quick-reactions"
								columns={3}
								type="button"
								class={styles.reaction}
								onClick={() => onReact(emoji)}
							>
								{emoji}
							</FocusButton>
						))}
					</div>
				)}
				{canReact && favouriteReactions.some((emoji) => availableReactions.includes(emoji)) && (
					<>
						<p class={styles.actionHeading}>Your frequent reactions</p>
						<div class={styles.reactionGrid}>
							{favouriteReactions.filter((emoji) => availableReactions.includes(emoji)).map((emoji) => (
								<FocusButton
									id={`message-favourite-reaction-${emoji}`}
									grid="favourite-reactions"
									columns={3}
									type="button"
									class={styles.reaction}
									onClick={() => onReact(emoji)}
								>
									{emoji}
								</FocusButton>
							))}
						</div>
					</>
				)}
				{canReact && (
					<FocusButton
						id="message-more-reactions"
						type="button"
						class={styles.moreReactions}
						onClick={onToggleExpanded}
					>
						More reactions…
					</FocusButton>
				)}
				<div class={styles.actionTiles}>
					<FocusButton
						id="message-action-reply"
						grid="message-actions"
						columns={2}
						type="button"
						class={styles.action}
						onClick={onReply}
					>
						<AppIcon name="reply" /> Reply
					</FocusButton>
					{capabilities?.forwarding !== false && (
						<FocusButton
							id="message-action-forward"
							grid="message-actions"
							columns={2}
							type="button"
							class={styles.action}
							onClick={onForward}
						>
							<AppIcon name="forward" /> Forward
						</FocusButton>
					)}
					{capabilities?.pins !== false && (
						<FocusButton
							id="message-action-pin"
							grid="message-actions"
							columns={2}
							type="button"
							class={styles.action}
							onClick={onPin}
						>
							<AppIcon name="pin" /> {message.pinned ? 'Unpin' : 'Pin'}
						</FocusButton>
					)}
					{capabilities?.edits !== false && message.direction === 'outgoing' && (
						<FocusButton
							id="message-action-edit"
							grid="message-actions"
							columns={2}
							type="button"
							class={styles.action}
							onClick={onEdit}
						>
							<AppIcon name="edit" /> Edit
						</FocusButton>
					)}
					{capabilities?.deletes !== false && message.direction === 'outgoing' && (
						<FocusButton
							id="message-action-delete"
							grid="message-actions"
							columns={2}
							type="button"
							class={styles.action}
							onClick={onDelete}
						>
							<AppIcon name="delete" /> Delete
						</FocusButton>
					)}
				</div>
				{capabilities?.polls !== false && message.poll && !message.poll.closed && (
					<>
						<p class={styles.actionHeading}>Poll</p>
						<div class={styles.pollActions}>
							{message.poll.options.map((option) => (
								<FocusButton
									id={`poll-vote-${option.index}`}
									type="button"
									class={styles.action}
									onClick={() => {
										if (!message.poll?.multiple) return onVote([option.index]);
										setPollChoices((current) =>
											current.includes(option.index)
												? current.filter((value) => value !== option.index)
												: [...current, option.index],
										);
									}}
								>
									{message.poll?.multiple ? (pollChoices.includes(option.index) ? '● ' : '○ ') : ''}
									{option.text}
								</FocusButton>
							))}
							{message.poll.multiple && (
								<FocusButton
									id="poll-submit"
									type="button"
									class={styles.action}
									disabled={!pollChoices.length}
									onClick={() => onVote(pollChoices)}
								>
									Submit vote
								</FocusButton>
							)}
							{message.direction === 'outgoing' && (
								<FocusButton id="poll-close" type="button" class={styles.action} onClick={onClosePoll}>
									Close poll
								</FocusButton>
							)}
						</div>
					</>
				)}
				{(message.reactions.length > 0 || (message.receipt?.readBy?.length ?? 0) > 0) && (
					<FocusButton
						id="message-details"
						type="button"
						class={styles.messageDetails}
						buttonRef={detailsRef}
						onArrow={(key) => {
							if (key !== 'ArrowUp' && key !== 'ArrowDown') return false;
							const element = detailsRef.current;
							if (!element) return false;
							const atTop = element.scrollTop <= 0;
							const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
							if ((key === 'ArrowUp' && atTop) || (key === 'ArrowDown' && atBottom)) return false;
							element.scrollBy({ top: key === 'ArrowUp' ? -80 : 80 });
							return true;
						}}
						onClick={() => undefined}
					>
						<strong>Message details</strong>
						{message.reactions.map((reaction) => (
							<span>
								{reaction.author}: {reaction.emoji}
							</span>
						))}
						{message.receipt?.readBy?.map((receipt) => (
							<span>
								{receipt.name}: {receipt.status}
								{receipt.at
									? ` at ${new Date(receipt.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
									: ''}
							</span>
						))}
					</FocusButton>
				)}
			</section>
		</main>
	);
}

export function ChatRoom({ conversation, initialMessage, onBack }: Props) {
	const { services, serviceFor } = useMessagingServices();
	const { activate, focus } = useFocusManager();
	const service = serviceFor(conversation.serviceId);
	const [currentConversation, setCurrentConversation] = useState({
		...conversation,
		expiration: conversation.expiration ?? 0,
		isBlocked: conversation.isBlocked ?? false,
		isMessageRequest: conversation.isMessageRequest ?? false,
		isIdentityChanged: conversation.isIdentityChanged ?? false,
		isInvited: conversation.isInvited ?? false,
		members: conversation.members ?? [],
		adminIds: conversation.adminIds ?? [],
		permissions: conversation.permissions ?? {},
	});
	const [page, setPage] = useState<MessagePage | undefined>(() => readMessagePage(conversation.id));
	const [capabilities, setCapabilities] = useState<ServiceCapabilities>();
	const [draft, setDraft] = useState(() => localStorage.getItem(`draft:${conversation.id}`) ?? '');
	const [error, setError] = useState<string>();
	const [olderNotice, setOlderNotice] = useState<string>();
	const [atBottom, setAtBottom] = useState(true);
	const [selectedMessageId, setSelectedMessageId] = useState<string>();
	const [composerFocused, setComposerFocused] = useState(false);
	const [composeControl, setComposeControl] = useState<
		'voice' | 'attachment' | 'sticker' | 'clear' | 'latest' | 'send'
	>();
	const [actionMessage, setActionMessage] = useState<UniversalMessage>();
	const [showOptions, setShowOptions] = useState(false);
	const [optionPanel, setOptionPanel] = useState<'pins' | 'poll' | 'group' | 'safety' | 'search' | 'local-names'>();
	const [localNicknames, setLocalNicknames] = useState<Record<string, string>>({});
	const [voiceOpen, setVoiceOpen] = useState(false);
	const [attachmentOpen, setAttachmentOpen] = useState(false);
	const [stickerOpen, setStickerOpen] = useState(false);
	const [forwarding, setForwarding] = useState<UniversalMessage>();
	const [destinations, setDestinations] = useState<UniversalConversation[]>([]);
	const [safetyNumber, setSafetyNumber] = useState('Loading…');
	const [pins, setPins] = useState<UniversalMessage[]>([]);
	const [pinIndex, setPinIndex] = useState(0);
	const [groupContacts, setGroupContacts] = useState<UniversalConversation[]>([]);
	const [viewer, setViewer] = useState<{ message: UniversalMessage; index: number }>();
	const [editing, setEditing] = useState<UniversalMessage>();
	const [expandedReactions, setExpandedReactions] = useState(false);
	const [reactionUsage, setReactionUsage] = useState<Record<string, number>>(() => {
		try {
			return JSON.parse(localStorage.getItem('reaction-usage') ?? '{}') as Record<string, number>;
		} catch {
			return {};
		}
	});
	const [replying, setReplying] = useState<UniversalMessage>();
	const timelineRef = useRef<HTMLElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const formRef = useRef<HTMLFormElement>(null);
	const messageElements = useRef(new Map<string, HTMLElement>());
	const audioElements = useRef(new Map<string, HTMLAudioElement>());
	const initialLoad = useRef(true);
	const followBottom = useRef(true);
	const pendingFocus = useRef<string>();
	const anchor = useRef<Anchor>();
	const typingTimer = useRef<number>();
	const reading = useRef(false);
	const draftBeforeEdit = useRef('');
	const composerFocusLocked = useRef(false);

	const captureAnchor = () => {
		const timeline = timelineRef.current;
		if (!timeline) return;
		const top = timeline.getBoundingClientRect().top;
		const visible = [...messageElements.current.entries()].find(
			([, element]) => element.getBoundingClientRect().bottom >= top,
		);
		if (visible) anchor.current = { id: visible[0], top: visible[1].getBoundingClientRect().top - top };
	};

	const load = async (before?: number): Promise<MessagePage | undefined> => {
		try {
			setError(undefined);
			if (before) captureAnchor();
			const next = await service.listMessages(conversation, { before });
			if (next.conversation) {
				setCurrentConversation((current) => ({ ...current, ...next.conversation }));
			}
			setPage((previous) => {
				if (!previous) {
					writeMessagePage(conversation.id, next);
					return next;
				}

				const seen = new Set(next.messages.map((message) => message.id));
				const merged = {
					...next,
					messages: [...next.messages, ...previous.messages.filter((message) => !seen.has(message.id))].sort(
						(first, second) => first.sentAt - second.sentAt,
					),
					hasMore: before ? next.hasMore : previous.hasMore || next.hasMore,
				};
				writeMessagePage(conversation.id, merged);
				return merged;
			});
			return next;
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : 'Unable to load messages');
			return undefined;
		}
	};

	useEffect(() => {
		void api<{ nicknames: Record<string, string> }>(
			`/api/local-nicknames?conversationId=${encodeURIComponent(conversation.id)}`,
		).then((response) => setLocalNicknames(response.nicknames)).catch(() => setLocalNicknames({}));
	}, [conversation.id]);

	useEffect(() => {
		if (initialMessage) {
			followBottom.current = false;
			pendingFocus.current = initialMessage.id;
			void load(initialMessage.sentAt + 1);
		} else {
			void load();
		}
		void service
			.capabilities()
			.then(setCapabilities)
			.catch(() => undefined);
		return () => {
			if (typingTimer.current) window.clearTimeout(typingTimer.current);
			void service.setTyping(conversation, false);
		};
	}, [conversation.id, initialMessage?.id]);

	useEffect(() => {
		if (
			actionMessage ||
			showOptions ||
			optionPanel ||
			viewer ||
			voiceOpen ||
			attachmentOpen ||
			stickerOpen ||
			forwarding
		) return;
		const timer = window.setInterval(() => void load(), 2_500);
		return () => window.clearInterval(timer);
	}, [
		actionMessage,
		attachmentOpen,
		conversation.id,
		forwarding,
		optionPanel,
		showOptions,
		stickerOpen,
		viewer,
		voiceOpen,
	]);

	useEffect(() => {
		const cached = readMessagePage(conversation.id);
		if (cached) setPage(cached);
	}, [conversation.id]);

	useLayoutEffect(() => {
		const timeline = timelineRef.current;
		if (!timeline || !page) return;

		if (initialLoad.current) {
			initialLoad.current = false;
			if (initialMessage) {
				followBottom.current = false;
				window.requestAnimationFrame(() => focus(`message-${initialMessage.id}`));
				return;
			}
			const unread = page.messages.find(
				(message) => message.direction === 'incoming' && message.sentAt > page.readThrough,
			);
			followBottom.current = !unread;
			if (unread) {
				pendingFocus.current = unread.id;
				focus(`message-${unread.id}`);
			} else {
				timeline.scrollTop = timeline.scrollHeight;
				inputRef.current?.focus({ preventScroll: true });
			}
			return;
		}

		if (followBottom.current) {
			timeline.scrollTop = timeline.scrollHeight;
			setAtBottom(true);
		}

		if (anchor.current) {
			const element = messageElements.current.get(anchor.current.id);
			if (element) {
				const top = element.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
				timeline.scrollTop += top - anchor.current.top;
			}
			anchor.current = undefined;
		}

		if (pendingFocus.current) {
			focus(`message-${pendingFocus.current}`);
			pendingFocus.current = undefined;
		}
	}, [page, focus]);

	useLayoutEffect(() => {
		if (!composerFocusLocked.current || document.activeElement === inputRef.current) return;
		if (actionMessage || showOptions || optionPanel || viewer || voiceOpen || attachmentOpen || stickerOpen || forwarding) return;
		focus('chat-compose');
	}, [
		actionMessage,
		attachmentOpen,
		focus,
		forwarding,
		optionPanel,
		page,
		showOptions,
		stickerOpen,
		viewer,
		voiceOpen,
	]);

	const scrollWithinMessage = (messageId: string, key: ArrowKey) => {
		if (key !== 'ArrowUp' && key !== 'ArrowDown') return false;
		const timeline = timelineRef.current;
		const element = messageElements.current.get(messageId);
		if (!timeline || !element) return false;

		const box = element.getBoundingClientRect();
		const viewport = timeline.getBoundingClientRect();
		const step = Math.max(100, viewport.height - 8);

		if (key === 'ArrowDown' && box.bottom > viewport.bottom + 1) {
			timeline.scrollBy({ top: Math.min(step, box.bottom - viewport.bottom) });
			return true;
		}

		if (key === 'ArrowUp' && box.top < viewport.top - 1) {
			timeline.scrollBy({ top: -Math.min(step, viewport.top - box.top) });
			return true;
		}

		return false;
	};

	const revealMessageStart = (messageId: string) => {
		const timeline = timelineRef.current;
		const element = messageElements.current.get(messageId);
		if (!timeline || !element) return;
		const top = element.getBoundingClientRect().top;
		const viewportTop = timeline.getBoundingClientRect().top;
		if (top < viewportTop) timeline.scrollBy({ top: top - viewportTop });
	};

	const localName = (name?: string) => (name ? localNicknames[name] || name : name);
	const displayMessage = (message: UniversalMessage): UniversalMessage => ({
		...message,
		sender: localName(message.sender),
		quote: message.quote ? { ...message.quote, author: localName(message.quote.author) || message.quote.author } : undefined,
		reactions: message.reactions.map((reaction) => ({ ...reaction, author: localName(reaction.author) || reaction.author })),
	});
	const localPeople = [...new Set([
		...(conversation.kind === 'direct' && !conversation.isNoteToSelf ? [conversation.title] : []),
		...currentConversation.members.map((member) => member.name),
		...(page?.messages.filter((message) => message.direction === 'incoming').map((message) => message.sender).filter(Boolean) ?? []),
	])].filter((name): name is string => Boolean(name));

	const markReadAtBottom = () => {
		const timeline = timelineRef.current;
		if (!timeline || reading.current) return;
		const distance = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
		if (distance > 20) {
			followBottom.current = false;
			setAtBottom(false);
			return;
		}

		followBottom.current = true;
		setAtBottom(true);
		reading.current = true;
		void service.markRead(conversation).finally(() => {
			reading.current = false;
		});
	};

	const updateDraft = (value: string) => {
		setDraft(value);
		if (value) localStorage.setItem(`draft:${conversation.id}`, value);
		else localStorage.removeItem(`draft:${conversation.id}`);

		void service.setTyping(conversation, true);
		if (typingTimer.current) window.clearTimeout(typingTimer.current);
		typingTimer.current = window.setTimeout(() => {
			void service.setTyping(conversation, false);
		}, 2_500);
	};

	const send = async (event: Event) => {
		event.preventDefault();
		const text = draft.trim();
		if (!text) return;
		try {
			setError(undefined);
			const wasEditing = Boolean(editing);
			if (editing) await service.editMessage(conversation, editing, text);
			else await service.sendText(conversation, text, replying);
			const restoredDraft = wasEditing ? draftBeforeEdit.current : '';
			setDraft(restoredDraft);
			if (restoredDraft) localStorage.setItem(`draft:${conversation.id}`, restoredDraft);
			else localStorage.removeItem(`draft:${conversation.id}`);
			setReplying(undefined);
			setEditing(undefined);
			followBottom.current = true;
			await service.setTyping(conversation, false);
			await load();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : 'Unable to send message');
		}
	};

	const loadOlder = () => {
		const first = page?.messages[0];
		if (!first) return;

		setOlderNotice(undefined);
		captureAnchor();
		pendingFocus.current = anchor.current?.id;
		void load(first.sentAt).then((next) => {
			if (next && next.messages.length === 0) setOlderNotice('No older cached messages.');
		});
	};

	const jumpToLatest = () => {
		const timeline = timelineRef.current;
		if (timeline) timeline.scrollTop = timeline.scrollHeight;
		followBottom.current = true;
		setAtBottom(true);
		inputRef.current?.focus({ preventScroll: true });
	};

	const jumpToQuotedMessage = (message: UniversalMessage) => {
		const quotedAt = message.quote?.sentAt;
		if (!quotedAt) {
			setError('The quoted message is unavailable.');
			return;
		}

		const existing = page?.messages.find((candidate) => candidate.sentAt === quotedAt);
		followBottom.current = false;
		if (existing) {
			window.requestAnimationFrame(() => focus(`message-${existing.id}`));
			return;
		}

		pendingFocus.current = undefined;
		void load(quotedAt + 1).then((next) => {
			const quoted = next?.messages.find((candidate) => candidate.sentAt === quotedAt);
			if (quoted) window.requestAnimationFrame(() => focus(`message-${quoted.id}`));
			else setError('The quoted message is no longer available.');
		});
	};

	const clearDraft = () => {
		setDraft('');
		setEditing(undefined);
		localStorage.removeItem(`draft:${conversation.id}`);
		inputRef.current?.focus({ preventScroll: true });
	};

	const focusJumpToLatest = () => {
		if (atBottom) return false;
		focus('chat-jump-latest');
		return true;
	};

	const focusLastMessage = () => {
		const message = [...(page?.messages ?? [])]
			.reverse()
			.find((candidate) => candidate.direction !== 'system');
		if (!message) return false;
		focus(`message-${message.id}`);
		return true;
	};

	const controlBeforeInput = () => {
		if (draft) return 'chat-clear-draft';
		if (capabilities?.stickers) return 'chat-stickers';
		if (capabilities?.attachments) return 'chat-attachment';
		if (capabilities?.voiceNotes) return 'chat-voice';
		return 'chat-compose';
	};

	const controlAfterVoice = () => {
		if (capabilities?.attachments) return 'chat-attachment';
		if (capabilities?.stickers) return 'chat-stickers';
		return draft ? 'chat-clear-draft' : 'chat-compose';
	};

	const controlAfterAttachment = () => {
		if (capabilities?.stickers) return 'chat-stickers';
		return draft ? 'chat-clear-draft' : 'chat-compose';
	};

	const controlBeforeSticker = () => {
		if (capabilities?.attachments) return 'chat-attachment';
		if (capabilities?.voiceNotes) return 'chat-voice';
		return 'chat-stickers';
	};

	const controlBeforeClear = () => {
		if (capabilities?.stickers) return 'chat-stickers';
		if (capabilities?.attachments) return 'chat-attachment';
		if (capabilities?.voiceNotes) return 'chat-voice';
		return 'chat-clear-draft';
	};

	const openMessageActions = () => {
		const message = page?.messages.find((candidate) => candidate.id === selectedMessageId);
		if (!message) return;
		setActionMessage(message);
		void service
			.getMessageDetails(conversation, message)
			.then(setActionMessage)
			.catch(() => undefined);
	};

	const openMedia = (message: UniversalMessage, index = 0) => {
		if (
			message.attachments.some((attachment) => attachment.kind === 'image' || attachment.kind === 'video')
		) {
			setViewer({ message, index });
		}
	};

	const toggleVoiceNote = (message: UniversalMessage) => {
		const audio = audioElements.current.get(message.id);
		if (!audio) return false;
		for (const [id, other] of audioElements.current) if (id !== message.id) other.pause();
		if (audio.paused) void audio.play();
		else audio.pause();
		return true;
	};

	const openViewOnce = (message: UniversalMessage) => {
		if (!message.viewOnce || message.viewOnce.opened) return false;
		void service
			.openViewOnce(message)
			.then((path) =>
				setViewer({
					message: { ...message, attachments: [{ id: 'view-once', kind: 'image', path }] },
					index: 0,
				}),
			)
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'View-once media unavailable'));
		return true;
	};

	const activateMessage = (message: UniversalMessage) => {
		if (message.quote?.sentAt) {
			jumpToQuotedMessage(message);
			return;
		}
		if (toggleVoiceNote(message)) return;
		if (openViewOnce(message)) return;
		if (
			message.attachments.some((attachment) => attachment.kind === 'image' || attachment.kind === 'video')
		) {
			openMedia(message);
			return;
		}
		quickReact(message);
	};

	const closeViewer = () => {
		const messageId = viewer?.message.id;
		setViewer(undefined);
		if (messageId) window.requestAnimationFrame(() => focus(`message-${messageId}`));
	};

	const closeMessageActions = () => {
		const messageId = actionMessage?.id;
		setActionMessage(undefined);
		if (messageId) window.requestAnimationFrame(() => focus(`message-${messageId}`));
	};

	const startReply = (message: UniversalMessage) => {
		setReplying(message);
		pendingFocus.current = undefined;
		composerFocusLocked.current = true;
		window.requestAnimationFrame(() => focus('chat-compose'));
	};

	const replyToMessage = () => {
		if (!actionMessage) return;
		const message = actionMessage;
		setActionMessage(undefined);
		startReply(message);
	};

	const sendReaction = (message: UniversalMessage, emoji: string) => {
		const messageId = message.id;
		const remove = message.reactions.some((reaction) => reaction.emoji === emoji && reaction.isOwn);
		if (!remove) {
			setReactionUsage((current) => {
				const next = { ...current, [emoji]: (current[emoji] ?? 0) + 1 };
				localStorage.setItem('reaction-usage', JSON.stringify(next));
				return next;
			});
		}
		void service
			.react(conversation, message, emoji, remove)
			.then(() => load())
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to react'));
		window.requestAnimationFrame(() => focus(`message-${messageId}`));
	};

	const quickReact = (message: UniversalMessage) => {
		if (capabilities?.reactions === false) {
			setActionMessage(message);
			return;
		}
		const emoji = page?.allowedReactions?.[0] ?? '👍';
		sendReaction(message, emoji);
	};

	const reactToMessage = (emoji: string) => {
		if (!actionMessage) return;
		const message = actionMessage;
		setActionMessage(undefined);
		setExpandedReactions(false);
		sendReaction(message, emoji);
	};

	const pinMessage = () => {
		if (!actionMessage) return;
		void service
			.pinMessage(conversation, actionMessage, !actionMessage.pinned)
			.then(() => {
				setActionMessage(undefined);
				void load();
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to pin message'));
	};

	const beginEdit = () => {
		if (!actionMessage) return;
		draftBeforeEdit.current = draft;
		setDraft(actionMessage.text ?? '');
		setEditing(actionMessage);
		setActionMessage(undefined);
	};

	const cancelEdit = () => {
		setEditing(undefined);
		setDraft(draftBeforeEdit.current);
		if (draftBeforeEdit.current) localStorage.setItem(`draft:${conversation.id}`, draftBeforeEdit.current);
		else localStorage.removeItem(`draft:${conversation.id}`);
		inputRef.current?.focus({ preventScroll: true });
	};

	const deleteMessage = () => {
		if (!actionMessage) return;
		void service
			.deleteMessage(conversation, actionMessage)
			.then(() => {
				setActionMessage(undefined);
				void load();
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to delete message'));
	};

	const beginForward = () => {
		if (!actionMessage) return;
		const source = actionMessage;
		void Promise.all(
			services.flatMap((candidate) => [
				candidate.listConversations({ archived: false }),
				candidate.listConversations({ archived: true }),
			]),
		)
			.then((pages) => {
				setDestinations(pages.flatMap((page) => page.conversations));
				setForwarding(source);
				setActionMessage(undefined);
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load chats'));
	};

	const forwardTo = async (message: UniversalMessage, target: UniversalConversation) => {
		if (target.serviceId === conversation.serviceId) {
			await service.forwardMessage(message, target);
			return;
		}

		const targetService = serviceFor(target.serviceId);
		const sender = message.direction === 'outgoing' ? 'You' : message.sender || conversation.title;
		const attribution = `Forwarded from ${sender} via ${conversation.serviceId}`;
		const text = [attribution, message.text].filter(Boolean).join('\n\n');
		const media = [
			...message.attachments,
			...(message.stickerPath
				? [{ id: 'sticker', kind: 'image' as const, path: message.stickerPath, filename: 'sticker.webp' }]
				: []),
		].filter((attachment) => attachment.path);

		if (!media.length) {
			await targetService.sendText(target, text || attribution);
			return;
		}

		for (const [index, attachment] of media.entries()) {
			const response = await fetch(attachment.path!, {
				headers: { authorization: `Bearer ${widgetToken()}` },
			});
			if (!response.ok) throw new Error('Unable to retrieve forwarded media');
			const blob = await response.blob();
			const file = new File(
				[blob],
				attachment.filename || `forwarded-${index + 1}`,
				{ type: attachment.contentType || blob.type },
			);
			await targetService.sendAttachment(target, file, index === 0 ? text : '');
		}
	};

	const jumpToSearchResult = (result: UniversalSearchResult) => {
		setOptionPanel(undefined);
		followBottom.current = false;
		pendingFocus.current = result.id;
		if (page?.messages.some((message) => message.id === result.id)) {
			window.requestAnimationFrame(() => focus(`message-${result.id}`));
			return;
		}
		void load(result.sentAt + 1);
	};

	const votePoll = (options: number[]) => {
		if (!actionMessage) return;
		void service
			.votePoll(conversation, actionMessage, options)
			.then(() => {
				setActionMessage(undefined);
				void load();
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to vote'));
	};

	const closePoll = () => {
		if (!actionMessage) return;
		void service
			.closePoll(conversation, actionMessage)
			.then(() => {
				setActionMessage(undefined);
				void load();
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to close poll'));
	};

	const updateConversation = (update: { archived?: boolean; favourite?: boolean; expiration?: number }) => {
		void service
			.updateConversation(conversation, update)
			.then(() => {
				setCurrentConversation((current) => ({
					...current,
					isArchived: update.archived ?? current.isArchived,
					isFavourite: update.favourite ?? current.isFavourite,
					expiration: update.expiration ?? current.expiration,
				}));
				setShowOptions(false);
				void load();
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to update chat'));
	};

	const openPins = () => {
		void service
			.listPinnedMessages(conversation)
			.then((messages) => {
				setPins(messages);
				setPinIndex(0);
				setShowOptions(false);
				setOptionPanel('pins');
			})
			.catch((reason) =>
				setError(reason instanceof Error ? reason.message : 'Unable to load pinned messages'),
			);
	};

	const jumpToPinnedMessage = (message: UniversalMessage) => {
		setOptionPanel(undefined);
		setShowOptions(false);
		pendingFocus.current = message.id;

		if (page?.messages.some((candidate) => candidate.id === message.id)) {
			window.requestAnimationFrame(() => focus(`message-${message.id}`));
			return;
		}

		followBottom.current = false;
		void load(message.sentAt + 1).then(() => {
			window.requestAnimationFrame(() => focus(`message-${message.id}`));
		});
	};

	const openSafety = () => {
		setOptionPanel('safety');
		setSafetyNumber('Loading…');
		void service
			.getSafetyNumber(conversation)
			.then(setSafetyNumber)
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load safety number'));
	};

	const openGroupSettings = () => {
		void service
			.listConversations({ archived: false })
			.then((result) => {
				const existing = new Set(currentConversation.members.map((member) => member.id));
				setGroupContacts(
					result.conversations.filter(
						(item) =>
							item.kind === 'direct' &&
							!item.isNoteToSelf &&
							!existing.has(item.remoteId.replace(/^direct:/, '')),
					),
				);
				setOptionPanel('group');
			})
			.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to load contacts'));
	};

	const refreshAfterOption = () => {
		setOptionPanel(undefined);
		setShowOptions(false);
		followBottom.current = true;
		void load();
	};

	useEffect(() => {
		if (!actionMessage) return;
		const firstReaction = page?.allowedReactions?.[0] ?? '👍';
		const reactionsUnavailable = page?.allowedReactions?.length === 0;
		window.requestAnimationFrame(() =>
			focus(
				expandedReactions
					? `message-all-reaction-${firstReaction}`
					: capabilities?.reactions === false || reactionsUnavailable
						? 'message-action-reply'
						: `message-reaction-${firstReaction}`,
			),
		);
	}, [actionMessage?.id, capabilities?.reactions, expandedReactions, focus, page?.allowedReactions]);

	useEffect(() => {
		if (!showOptions || optionPanel) return;
		const first = capabilities?.polls
			? 'chat-option-poll'
			: capabilities?.pins
				? 'chat-option-pins'
				: currentConversation.kind === 'group'
					? 'chat-option-group'
					: capabilities?.identities && !currentConversation.isNoteToSelf
						? 'chat-option-safety'
						: capabilities?.blocking && !currentConversation.isNoteToSelf
							? 'chat-option-block'
							: 'chat-option-expiration';
		window.requestAnimationFrame(() => focus(first));
	}, [capabilities, focus, optionPanel, showOptions]);

	useEffect(() => {
		if (voiceOpen) window.requestAnimationFrame(() => focus('voice-toggle'));
	}, [focus, voiceOpen]);

	useEffect(() => {
		if (attachmentOpen) window.requestAnimationFrame(() => focus('attachment-choose'));
	}, [attachmentOpen, focus]);

	const goBack = () => {
		if (stickerOpen) {
			setStickerOpen(false);
			window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
			return;
		}
		if (forwarding) {
			const messageId = forwarding.id;
			setForwarding(undefined);
			window.requestAnimationFrame(() => focus(`message-${messageId}`));
			return;
		}
		if (attachmentOpen) {
			setAttachmentOpen(false);
			window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
			return;
		}
		if (viewer) return closeViewer();
		if (actionMessage) {
			if (expandedReactions) setExpandedReactions(false);
			else closeMessageActions();
			return;
		}
		if (optionPanel) return setOptionPanel(undefined);
		if (showOptions) return setShowOptions(false);
		onBack();
	};

	const composerSoftkeyLabel = () => {
		if (composeControl === 'voice') return 'Record';
		if (composeControl === 'attachment') return 'Attach';
		if (composeControl === 'sticker') return 'Stickers';
		if (composeControl === 'clear') return 'Clear';
		if (composeControl === 'latest') return 'Latest';
		if (composeControl === 'send') return editing ? 'Save' : 'Send';
		if (composerFocused) return 'Type';
		if (selectedMessageId) {
			const message = page?.messages.find((candidate) => candidate.id === selectedMessageId);
			if (message?.quote?.sentAt) return 'Goto Quote';
			if (message?.attachments.some((attachment) => attachment.kind === 'image' || attachment.kind === 'video')) {
				return message.attachments.some((attachment) => attachment.kind === 'video')
					? 'Play video'
					: 'View photo';
			}
			if (message?.attachments.some((attachment) => attachment.kind === 'audio')) return 'Play';
			return capabilities?.reactions === false ? 'Open' : 'React';
		}
		return 'Type';
	};

	useSoftkeys(
		{
			left:
				actionMessage || showOptions || optionPanel || stickerOpen || forwarding || attachmentOpen
					? undefined
					: selectedMessageId
						? { label: 'Message', onPress: openMessageActions }
						: { label: 'Options', onPress: () => setShowOptions(true) },
			center: viewer || stickerOpen || forwarding || attachmentOpen
				? { label: 'Select', onPress: activate }
				: actionMessage
					? { label: 'Select', onPress: activate }
					: optionPanel === 'pins'
						? {
								label: 'Jump',
								onPress: () => {
									const pin = pins[pinIndex];
									if (pin) jumpToPinnedMessage(pin);
								},
							}
							: showOptions || optionPanel
								? { label: 'Select', onPress: activate }
								: {
										label: composerSoftkeyLabel(),
										onPress: () => {
											if (composeControl) activate();
											else if (composerFocused) inputRef.current?.focus();
											else if (selectedMessageId) {
												const message = page?.messages.find((candidate) => candidate.id === selectedMessageId);
												if (message) activateMessage(message);
											} else inputRef.current?.focus();
										},
									},
			right: {
				label: 'Back',
				onPress: goBack,
			},
		},
		[
			actionMessage,
			expandedReactions,
			composeControl,
			composerFocused,
			editing,
			onBack,
			page,
			pinIndex,
			pins,
			selectedMessageId,
			activate,
			optionPanel,
			showOptions,
			stickerOpen,
			forwarding,
			attachmentOpen,
			viewer,
		],
	);

	let currentDay = '';
	let unreadShown = false;
	let previousMessage: UniversalMessage | undefined;

	if (actionMessage) {
		return (
			<MessageActions
				message={actionMessage}
				capabilities={capabilities}
				onReply={replyToMessage}
				onReact={reactToMessage}
				onEdit={beginEdit}
				onDelete={deleteMessage}
				onPin={pinMessage}
				onForward={beginForward}
				expanded={expandedReactions}
				onToggleExpanded={() => setExpandedReactions((value) => !value)}
				onVote={votePoll}
				onClosePoll={closePoll}
				favouriteReactions={Object.entries(reactionUsage)
					.filter(([emoji]) => !['👍', '❤️', '😂', '😮', '😢', '🙏'].includes(emoji))
					.sort(([, first], [, second]) => second - first)
					.slice(0, 6)
					.map(([emoji]) => emoji)}
				allowedReactions={page?.allowedReactions}
			/>
		);
	}

	if (viewer) {
		const media = viewer.message.attachments.filter(
			(attachment) => attachment.kind === 'image' || attachment.kind === 'video',
		);
		const attachment = media[viewer.index];
		if (attachment) {
			return (
				<MediaViewer
					message={viewer.message}
					attachment={attachment}
					index={viewer.index}
					onBack={closeViewer}
					onChange={(direction) =>
						setViewer((current) =>
							current
								? { ...current, index: (current.index + direction + media.length) % media.length }
								: current,
						)
					}
				/>
			);
		}
	}

	if (stickerOpen) {
		return (
			<StickerPicker
				service={service}
				onChoose={(sticker) => {
					void service
						.sendSticker(conversation, sticker)
						.then(() => {
							setStickerOpen(false);
							followBottom.current = true;
							void load();
							window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
						})
						.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to send sticker'));
				}}
			/>
		);
	}

	if (forwarding) {
		return (
			<ConversationPicker
				title="Forward to"
				conversations={destinations}
				onChoose={(target) => {
					void forwardTo(forwarding, target)
						.then(() => {
							const messageId = forwarding.id;
							setForwarding(undefined);
							window.requestAnimationFrame(() => focus(`message-${messageId}`));
						})
						.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to forward'));
				}}
			/>
		);
	}

	if (optionPanel === 'poll') {
		return (
			<PollComposer
				onCreate={(question, options, multiple) => {
					void service
						.createPoll(conversation, question, options, multiple)
						.then(refreshAfterOption)
						.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to create poll'));
				}}
			/>
		);
	}

	if (optionPanel === 'group') {
		return (
			<GroupSettings
				conversation={currentConversation}
				contacts={groupContacts}
				onUpdate={(changes) => {
					void service
						.updateGroup(conversation, changes)
						.then(refreshAfterOption)
						.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to update group'));
				}}
				onLeave={() => {
					void service
						.leaveGroup(conversation)
						.then(onBack)
						.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to leave group'));
				}}
			/>
		);
	}

	if (optionPanel === 'safety') {
		return (
			<SafetyNumber
				value={safetyNumber}
				onTrust={(entered) => {
					void service
						.trustSafetyNumber(conversation, entered)
						.then(refreshAfterOption)
						.catch((reason) =>
							setError(reason instanceof Error ? reason.message : 'Unable to verify safety number'),
						);
				}}
			/>
		);
	}

	if (optionPanel === 'search') {
		return (
			<ChatSearch
				service={service}
				conversation={conversation}
				onChoose={jumpToSearchResult}
			/>
		);
	}

	if (optionPanel === 'local-names') {
		return (
			<LocalNicknameEditor
				people={localPeople}
				nicknames={localNicknames}
				onSave={(nicknames) => {
					void api<{ nicknames: Record<string, string> }>('/api/local-nicknames', {
						method: 'POST',
						body: JSON.stringify({ conversationId: conversation.id, nicknames }),
					})
						.then((response) => {
							setLocalNicknames(response.nicknames);
							setOptionPanel(undefined);
						})
						.catch((reason) => setError(reason instanceof Error ? reason.message : 'Unable to save local names'));
				}}
			/>
		);
	}

	if (showOptions) {
		return (
			<ChatOptions
				conversation={currentConversation}
				capabilities={capabilities}
				onSearch={() => {
					setShowOptions(false);
					setOptionPanel('search');
				}}
				onExpiration={(expiration) => updateConversation({ expiration })}
				onPoll={() => setOptionPanel('poll')}
				onPins={openPins}
				onGroup={openGroupSettings}
				onBlock={() => {
					void service
						.setBlocked(conversation, !currentConversation.isBlocked)
						.then(() => {
							setCurrentConversation((current) => ({ ...current, isBlocked: !current.isBlocked }));
							refreshAfterOption();
						})
						.catch((reason) =>
							setError(reason instanceof Error ? reason.message : 'Unable to change block status'),
						);
				}}
				onMessageRequest={(response) => {
					void service
						.respondToMessageRequest(conversation, response)
						.then(refreshAfterOption)
						.catch((reason) =>
							setError(reason instanceof Error ? reason.message : 'Unable to handle request'),
						);
				}}
				onSafety={openSafety}
				onGroupInvite={(accept) => {
					const operation = accept ? service.updateGroup(conversation, {}) : service.leaveGroup(conversation);
					void operation
						.then(refreshAfterOption)
						.catch((reason) =>
							setError(reason instanceof Error ? reason.message : 'Unable to handle group invitation'),
					);
				}}
				onLocalNames={() => {
					setShowOptions(false);
					setOptionPanel('local-names');
				}}
			/>
		);
	}

	return (
		<main class={styles.room}>
			<header class={styles.header}>
				<span class={styles.title}>{localName(conversation.title)}</span>
				<span class={styles.service}>{conversation.serviceId}</span>
			</header>
			<section
				class={`${styles.timeline} ${optionPanel === 'pins' ? styles.blurred : ''}`}
				ref={timelineRef}
				onScroll={markReadAtBottom}
			>
				{currentConversation.isIdentityChanged && (
					<p class={styles.identityWarning}>Safety number changed — verify this contact in Chat options.</p>
				)}
				{page && (
					<FocusButton id="load-older-messages" class={styles.loadOlder} type="button" onClick={loadOlder}>
						Load older messages
					</FocusButton>
				)}
				{olderNotice && <p class={styles.notice}>{olderNotice}</p>}
				{error && <p class={styles.error}>{error}</p>}
				{!error && !page && <p class={styles.empty}>Loading messages…</p>}
				{page?.messages.map((message) => {
					const shownMessage = displayMessage(message);
					const day = new Date(message.sentAt).toDateString();
					const showDate = day !== currentDay;
					currentDay = day;
					const showUnread =
						!unreadShown && message.direction === 'incoming' && message.sentAt > page.readThrough;
					if (showUnread) unreadShown = true;
					const sameIncomingSender =
						previousMessage?.direction === 'incoming' &&
						message.direction === 'incoming' &&
						previousMessage.sender === message.sender;
					const showSender =
						conversation.kind === 'group' && message.direction === 'incoming' && !sameIncomingSender;
					const previousMinute = previousMessage ? Math.floor(previousMessage.sentAt / 60_000) : undefined;
					const showTime = previousMinute !== Math.floor(message.sentAt / 60_000);
					const groupStart = !sameIncomingSender && Boolean(previousMessage) && !showSender;
					previousMessage = message;

					return (
						<div
							ref={(element) => {
								if (element) messageElements.current.set(message.id, element);
								else messageElements.current.delete(message.id);
							}}
						>
							{showDate && (
								<div class={styles.dateSeparator}>
									<span>
										{new Date(message.sentAt).toLocaleDateString([], {
											weekday: 'short',
											day: 'numeric',
											month: 'short',
										})}
									</span>
								</div>
							)}
							{showUnread && <div class={styles.unreadMarker}>Unread messages</div>}
							{showSender && <span class={styles.sender}>{localName(message.sender)}</span>}
							<MessageBubble
								message={shownMessage}
								showTime={showTime}
								groupStart={groupStart}
								onOpenMedia={(index = 0) => openMedia(message, index)}
								onActivate={() => activateMessage(message)}
								onAudioReady={(audio) => {
									if (audio) audioElements.current.set(message.id, audio);
									else audioElements.current.delete(message.id);
								}}
									onFocus={() => {
									pendingFocus.current = message.id;
									revealMessageStart(message.id);
									setSelectedMessageId(message.id);
									setComposerFocused(false);
									setComposeControl(undefined);
									composerFocusLocked.current = false;
									window.requestAnimationFrame(markReadAtBottom);
								}}
								onArrow={(key) => {
									if (key === 'ArrowRight') return focusJumpToLatest();
									if (key === 'ArrowLeft') {
										startReply(message);
										return true;
									}
									if (
										key === 'ArrowDown' &&
										!page.messages
											.slice(page.messages.indexOf(message) + 1)
											.some((candidate) => candidate.direction !== 'system')
									) {
										focus('chat-compose');
										return true;
									}
									return scrollWithinMessage(message.id, key);
								}}
							/>
						</div>
					);
				})}
				{page?.typingNames.length ? (
					<div class={styles.typing} aria-label={`${page.typingNames.map(localName).join(', ')} typing`}>
						<span />
						<span />
						<span />
					</div>
				) : null}
			</section>
			{optionPanel === 'pins' && (
				<PinnedMessages
					pins={pins}
					index={pinIndex}
					onChange={(direction) =>
						setPinIndex((current) => (pins.length ? (current + direction + pins.length) % pins.length : 0))
					}
					onJump={jumpToPinnedMessage}
				/>
			)}
			{!atBottom && (
				<FocusButton
					id="chat-jump-latest"
					class={styles.floatingLatest}
					type="button"
					onClick={jumpToLatest}
					aria-label="Jump to latest message"
				>
					↓
				</FocusButton>
			)}
			{voiceOpen && capabilities?.voiceNotes && (
				<VoiceComposer
					onClose={() => {
						setVoiceOpen(false);
						inputRef.current?.focus({ preventScroll: true });
					}}
					onSend={async (recording) => {
						await service.sendVoiceNote(conversation, recording);
						followBottom.current = true;
						await load();
					}}
				/>
			)}
			{attachmentOpen && capabilities?.attachments && (
				<AttachmentComposer
					caption={draft}
					onClose={() => {
						setAttachmentOpen(false);
						window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
					}}
					onSend={async (file, caption) => {
						await service.sendAttachment(conversation, file, caption);
						if (caption) clearDraft();
						followBottom.current = true;
						await load();
					}}
				/>
			)}
			<form class={styles.compose} ref={formRef} onSubmit={send}>
				{editing && (
					<div class={styles.replying}>
						<span>Editing message</span>
						<button type="button" onClick={cancelEdit}>
							×
						</button>
					</div>
				)}
				{replying && (
					<div class={styles.replying}>
						<span>
							Replying to{' '}
							{replying.direction === 'outgoing' ? 'your message' : (replying.sender ?? 'message')}
						</span>
						<FocusButton
							id="chat-cancel-reply"
							type="button"
							onFocus={() => {
								composerFocusLocked.current = false;
							}}
							onArrow={(key) => {
								if (key === 'ArrowDown') {
									focus('chat-compose');
									return true;
								}
								return key === 'ArrowUp';
							}}
							onClick={() => {
								setReplying(undefined);
								window.requestAnimationFrame(() => focus('chat-compose'));
							}}
							aria-label="Cancel reply"
						>
							×
						</FocusButton>
					</div>
				)}
				{capabilities?.voiceNotes && (
					<FocusButton
						id="chat-voice"
						vertical={false}
						class={styles.utility}
						type="button"
						onFocus={() => {
							setComposeControl('voice');
							setComposerFocused(false);
							setSelectedMessageId(undefined);
							composerFocusLocked.current = false;
						}}
						onArrow={(key) => {
							if (key === 'ArrowRight') {
								focus(controlAfterVoice());
								return true;
							}
							return true;
						}}
						onClick={() => setVoiceOpen(true)}
						aria-label="Record voice note"
					>
						<AppIcon name="mic" />
					</FocusButton>
				)}
				{capabilities?.attachments && (
					<FocusButton
						id="chat-attachment"
						vertical={false}
						class={styles.utility}
						type="button"
						onFocus={() => {
							setComposeControl('attachment');
							setComposerFocused(false);
							setSelectedMessageId(undefined);
							composerFocusLocked.current = false;
						}}
						onArrow={(key) => {
							if (key === 'ArrowLeft') focus(capabilities?.voiceNotes ? 'chat-voice' : 'chat-attachment');
							if (key === 'ArrowRight') focus(controlAfterAttachment());
							return true;
						}}
						onClick={() => setAttachmentOpen(true)}
						aria-label="Send attachment"
					>
						<AppIcon name="attach" />
					</FocusButton>
				)}
				{capabilities?.stickers && (
					<FocusButton
						id="chat-stickers"
						vertical={false}
						class={styles.utility}
						type="button"
						onFocus={() => {
							setComposeControl('sticker');
							setComposerFocused(false);
							setSelectedMessageId(undefined);
							composerFocusLocked.current = false;
						}}
						onArrow={(key) => {
							if (key === 'ArrowLeft') focus(controlBeforeSticker());
							if (key === 'ArrowRight') focus(draft ? 'chat-clear-draft' : 'chat-compose');
							return true;
						}}
						onClick={() => setStickerOpen(true)}
						aria-label="Send sticker"
					>
						<AppIcon name="sticker" />
					</FocusButton>
				)}
				<FocusButton
						id="chat-clear-draft"
						class={`${styles.utility} ${styles.clearDraft} ${draft ? styles.clearDraftVisible : ''}`}
						type="button"
						disabled={!draft}
						onArrow={(key) => {
							if (key === 'ArrowLeft') focus(controlBeforeClear());
							if (key === 'ArrowRight') focus('chat-compose');
							return true;
						}}
						onFocus={() => {
							setComposeControl('clear');
							setComposerFocused(false);
							setSelectedMessageId(undefined);
							composerFocusLocked.current = false;
						}}
						onClick={clearDraft}
						aria-label="Clear draft"
					>
						×
					</FocusButton>
				<FocusInput
					id="chat-compose"
					inputRef={inputRef}
					value={draft}
					maxlength={4000}
					autocomplete="off"
					placeholder="Message"
					onFocus={() => {
						setComposerFocused(true);
						setSelectedMessageId(undefined);
						setComposeControl(undefined);
						pendingFocus.current = undefined;
						composerFocusLocked.current = true;
					}}
					onArrow={(key) => {
						if (key === 'ArrowUp') {
							if (replying) {
								focus('chat-cancel-reply');
								return true;
							}
							return focusLastMessage();
						}
						if (key === 'ArrowLeft') {
							focus(controlBeforeInput());
							return true;
						}
						if (key === 'ArrowRight') {
							focus('chat-send');
							return true;
						}
						return key === 'ArrowDown';
					}}
					onKeyDown={(event) => {
						if (event.key !== 'Enter') return;
						event.preventDefault();
						formRef.current?.requestSubmit();
					}}
					onInput={(event) => updateDraft(event.currentTarget.value)}
				/>
				<FocusButton
					id="chat-send"
					vertical={false}
					type="submit"
					aria-label="Send"
					onFocus={() => {
						setComposerFocused(false);
						setComposeControl('send');
						setSelectedMessageId(undefined);
						composerFocusLocked.current = false;
					}}
					onArrow={(key) => {
						if (key === 'ArrowLeft') {
							inputRef.current?.focus({ preventScroll: true });
							return true;
						}
						if (key === 'ArrowUp') return focusLastMessage();
						return key === 'ArrowRight';
					}}
				>
					➤
				</FocusButton>
			</form>
		</main>
	);
}
