import { AppIcon } from '../../components/AppIcon';
import { ServiceIcon } from '../../components/ServiceIcon';
import { FocusButton } from '../../components/FocusButton';
import { useProtectedImage } from '../../hooks/useProtectedImage';
import type { UniversalConversation, UniversalMessage } from '../../services/contracts';
import styles from './ConversationList.module.scss';

type Props = {
	conversation: UniversalConversation;
	onOpen: () => void;
	onFocus?: () => void;
	autoFocus?: boolean;
	idPrefix?: string;
};

function initials(value: string) {
	return (
		value
			.split(/\s+/)
			.slice(0, 2)
			.map((part) => part[0])
			.join('')
			.toUpperCase() || '?'
	);
}

function firstName(name?: string) {
	return name?.trim().split(/\s+/)[0];
}

function messageSummary(message?: UniversalMessage) {
	if (!message) return 'No messages yet';
	if (message.text) return message.text;
	const attachment = message.attachments[0];
	if (attachment?.kind === 'image') return 'Photo';
	if (attachment?.kind === 'video') return 'Video';
	if (attachment?.kind === 'audio') return 'Voice note';
	return attachment ? 'Attachment' : 'Message';
}

function Preview({ conversation }: { conversation: UniversalConversation }) {
	if (conversation.typingNames.length) {
		const names = conversation.typingNames.map((name) => firstName(name) ?? name).join(', ');
		return (
			<span class={styles.typing} aria-label={`${names} typing`}>
				<span class={styles.typingDots} aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
				{names} typing
			</span>
		);
	}

	const message = conversation.lastMessage;
	const sender =
		message?.direction === 'outgoing'
			? 'You'
			: conversation.kind === 'group'
				? (firstName(message?.sender) ?? 'Someone')
				: conversation.title;

	return (
		<>
			<strong>{sender}:</strong> {messageSummary(message)}
		</>
	);
}

function PreviewReceipt({ message }: { message?: UniversalMessage }) {
	if (message?.direction !== 'outgoing' || !message.receipt) return null;
	const mark = message.receipt.state === 'sent' ? '✓' : '✓✓';
	const className = `${styles.previewReceipt} ${styles[message.receipt.state] ?? ''}`;
	return <span class={className}>{mark}</span>;
}

function memberAvatarPath(conversation: UniversalConversation, memberId: string) {
	if (conversation.serviceId === 'signal') {
		return `/api/avatar/direct/${encodeURIComponent(memberId)}`;
	}
	if (conversation.serviceId === 'telegram') {
		return `/api/services/telegram/avatar/${encodeURIComponent(memberId)}`;
	}
	return undefined;
}

function MemberTile({
	conversation,
	memberId,
	memberName,
}: {
	conversation: UniversalConversation;
	memberId: string;
	memberName: string;
}) {
	const source = useProtectedImage(memberAvatarPath(conversation, memberId));

	return <span class={styles.memberTile}>{source ? <img src={source} alt="" /> : initials(memberName)}</span>;
}

function MemberMosaic({ conversation }: { conversation: UniversalConversation }) {
	const members = conversation.members.slice(0, 4);
	if (members.length < 2) return null;

	return (
		<span class={styles.memberMosaic} aria-label={`${conversation.title} members`}>
			{members.map((member) => (
				<MemberTile
					key={member.id}
					conversation={conversation}
					memberId={member.id}
					memberName={member.name}
				/>
			))}
		</span>
	);
}

function Avatar({ conversation }: { conversation: UniversalConversation }) {
	const source = useProtectedImage(conversation.avatarPath);
	const className = `${styles.avatar} ${conversation.isNoteToSelf ? styles.noteAvatar : ''}`;
	const showMosaic = !source && conversation.kind === 'group' && conversation.members.length >= 2;

	return (
		<span class={className} aria-hidden="true">
			{conversation.isNoteToSelf ? '🔖' : initials(conversation.title)}
			{source && <img src={source} alt="" />}
			{showMosaic && <MemberMosaic conversation={conversation} />}
			{conversation.unreadCount > 0 && <span class={styles.unread}>{conversation.unreadCount}</span>}
		</span>
	);
}

export function sortConversations(conversations: UniversalConversation[]) {
	return [...conversations].sort((first, second) => {
		const favouriteDifference = Number(second.isFavourite) - Number(first.isFavourite);
		return favouriteDifference || (second.lastMessage?.sentAt ?? 0) - (first.lastMessage?.sentAt ?? 0);
	});
}

export function ConversationRow({
	conversation,
	onOpen,
	onFocus,
	autoFocus = false,
	idPrefix = 'conversation',
}: Props) {
	return (
		<FocusButton
			id={`${idPrefix}-${conversation.id}`}
			type="button"
			class={styles.row}
			autoFocus={autoFocus}
			onFocus={onFocus}
			onClick={onOpen}
		>
			<Avatar conversation={conversation} />
			<span class={styles.body}>
				<span class={styles.title}>
					<span class={styles.titleText}>
						{conversation.isFavourite && '★ '}
						{conversation.title}
					</span>
					<span class={styles.indicators}>
						{conversation.isMuted && (
							<span class={styles.mutedIcon} aria-label="Muted">
								<AppIcon name="mute" />
							</span>
						)}
						<span class={styles.serviceIcon} aria-label={`${conversation.serviceId} conversation`}>
							<ServiceIcon service={conversation.serviceId} />
						</span>
					</span>
				</span>
				<span class={styles.preview}>
					<Preview conversation={conversation} />
					<PreviewReceipt message={conversation.lastMessage} />
				</span>
			</span>
		</FocusButton>
	);
}
