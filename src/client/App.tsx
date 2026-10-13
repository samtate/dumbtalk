import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, ApiError, claimInstallation, hasWidgetToken } from './api/client';
import { FocusButton } from './components/FocusButton';
import { ChatRoom } from './features/chat/ChatRoom';
import {
	ComposeScreen,
	MainMenu,
	NewGroupScreen,
	SearchScreen,
	SettingsScreen,
} from './features/app/AppScreens';
import { ConversationList } from './features/conversations/ConversationList';
import { ServicesScreen } from './features/services/ServicesScreen';
import { FocusProvider, useFocusManager } from './platform/Focus';
import { SoftkeyProvider, useSoftkeys } from './platform/Softkeys';
import { MessagingServiceProvider, useMessagingServices } from './services/ServiceContext';
import type { UniversalConversation, UniversalSearchResult } from './services/contracts';
import styles from './styles/App.module.scss';

type Status = {
	signalReady: boolean;
	linked: boolean;
	anyLinked?: boolean;
};

const STATUS_CACHE_KEY = 'dumbtalk:boot-status';

function cachedStatus(): Status | undefined {
	try {
		const cached = JSON.parse(localStorage.getItem(STATUS_CACHE_KEY) ?? '') as { savedAt?: number; status?: Status };
		return cached.savedAt && Date.now() - cached.savedAt < 24 * 60 * 60_000 ? cached.status : undefined;
	} catch {
		return undefined;
	}
}

function ErrorScreen({ message, retry }: { message: string; retry: () => void }) {
	const { activate } = useFocusManager();

	useSoftkeys(
		{
			center: { label: 'Retry', onPress: activate },
			right: { label: 'Exit', onPress: () => window.close() },
		},
		[],
	);

	return (
		<main class={`${styles.screen} ${styles.centered}`}>
			<img class={styles.logo} src="/dumbtalk.png" alt="" />
			<p class={styles.error}>{message}</p>
			<FocusButton id="startup-retry" type="button" onClick={retry}>
				Retry
			</FocusButton>
		</main>
	);
}

type Screen =
	| { name: 'conversations'; archived: boolean }
	| { name: 'menu'; selected?: UniversalConversation; fromArchived?: boolean }
	| { name: 'compose' }
	| { name: 'group' }
	| { name: 'search' }
	| { name: 'settings' }
	| { name: 'services' }
	| { name: 'onboarding' }
	| { name: 'chat'; conversation: UniversalConversation; result?: UniversalSearchResult };

function UnifiedApp() {
	const [screen, setScreen] = useState<Screen>({ name: 'conversations', archived: false });
	const { services } = useMessagingServices();
	useEffect(() => {
		const android = (window as Window & { dumbtalkAndroid?: {
			pendingChat?: () => string; openedChat?: (id: string) => void;
		} }).dumbtalkAndroid;
		if (!android?.pendingChat) return;
		let cancelled = false;
		let loading = false;
		const openPending = async () => {
			const id = android.pendingChat!();
			if (!id || loading) return;
			const service = services.find(item => id.startsWith(item.id + ':'));
			if (!service) return;
			loading = true;
			try {
				let conversation: UniversalConversation | undefined;
				for (const archived of [false, true]) {
					const page = await service.listConversations({ archived });
					conversation = page.conversations.find(item => item.id === id);
					if (conversation) break;
				}
				if (!cancelled && conversation && android.pendingChat!() === id) {
					setScreen({ name: 'chat', conversation });
					android.openedChat?.(id);
				}
			} catch { /* Keep the intent pending so a reconnect can retry. */ }
			finally { loading = false; }
		};
		void openPending();
		window.addEventListener('dumbtalk-open-chat', openPending);
		const retry = window.setInterval(openPending, 3000);
		return () => { cancelled = true; window.clearInterval(retry); window.removeEventListener('dumbtalk-open-chat', openPending); };
	}, [services]);

	useEffect(() => {
		const android = (window as Window & { dumbtalkAndroid?: { set: (screen: string, conversationId: string) => void } }).dumbtalkAndroid;
		if (!android) return;
		const report = () => android.set(screen.name, screen.name === 'chat' ? screen.conversation.id : '');
		report();
		window.addEventListener('dumbtalk-resume', report);
		return () => window.removeEventListener('dumbtalk-resume', report);
	}, [screen]);

	if (screen.name === 'services') {
		return (
			<ServicesScreen
				onBack={() => setScreen({ name: 'conversations', archived: false })}
			/>
		);
	}

	if (screen.name === 'onboarding') {
		return (
			<ServicesScreen
				onboarding
				onConnected={() => setScreen({ name: 'conversations', archived: false })}
			/>
		);
	}

	if (screen.name === 'menu') {
		return (
			<MainMenu
				selected={screen.selected}
				onBack={() => setScreen({ name: 'conversations', archived: Boolean(screen.fromArchived) })}
				onCompose={() => setScreen({ name: 'compose' })}
				onGroup={() => setScreen({ name: 'group' })}
				onSearch={() => setScreen({ name: 'search' })}
				onSettings={() => setScreen({ name: 'settings' })}
				onArchived={() => setScreen({ name: 'conversations', archived: true })}
				onServices={() => setScreen({ name: 'services' })}
			/>
		);
	}

	if (screen.name === 'compose') {
		return (
			<ComposeScreen
				onBack={() => setScreen({ name: 'conversations', archived: false })}
				onOpen={(conversation) => setScreen({ name: 'chat', conversation })}
			/>
		);
	}

	if (screen.name === 'group') {
		return <NewGroupScreen onBack={() => setScreen({ name: 'conversations', archived: false })} />;
	}

	if (screen.name === 'search') {
		return (
			<SearchScreen
				onBack={() => setScreen({ name: 'conversations', archived: false })}
				onOpen={(conversation, result) => setScreen({ name: 'chat', conversation, result })}
			/>
		);
	}

	if (screen.name === 'settings') {
		return <SettingsScreen onBack={() => setScreen({ name: 'menu' })} />;
	}

	if (screen.name === 'chat') {
		return (
			<ChatRoom
				conversation={screen.conversation}
				initialMessage={screen.result}
				onBack={() => setScreen({ name: 'conversations', archived: false })}
			/>
		);
	}

	return (
		<ConversationList
			archived={screen.archived}
			onMenu={(selected) => setScreen({ name: 'menu', selected, fromArchived: screen.archived })}
			onArchived={() => setScreen({ name: 'conversations', archived: !screen.archived })}
			onOpen={(conversation) => setScreen({ name: 'chat', conversation })}
		/>
	);
}

function Boot() {
	const [status, setStatus] = useState<Status | undefined>(cachedStatus);
	const [error, setError] = useState<string>();

	const load = useCallback(() => {
		if (!hasWidgetToken()) {
			setError(undefined);
			void claimInstallation().then(() => window.location.reload()).catch((reason: unknown) => {
				setError(reason instanceof Error ? reason.message : 'Unable to set up DumbTalk');
			});
			return;
		}

		setError(undefined);
		void api<Status>('/api/status')
			.then((next) => {
				setStatus(next);
				try {
					localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), status: next }));
				} catch {}
			})
			.catch((reason: unknown) => {
				const failure = reason as ApiError;
				setError(failure.status === 404 ? 'This widget is not configured.' : failure.message);
			});
	}, []);

	useEffect(load, [load]);
	useEffect(() => {
		if (!status || status.signalReady) return;
		const timer = window.setTimeout(load, 2_000);
		return () => window.clearTimeout(timer);
	}, [load, status]);

	if (error) {
		return <ErrorScreen message={error} retry={load} />;
	}

	// Render the cached conversation shell immediately. The service provider
	// refreshes status and conversations in the background without a splash.
	if (!status || !status.signalReady) return <MessagingServiceProvider><UnifiedApp /></MessagingServiceProvider>;

	if (!(status.anyLinked ?? status.linked)) {
		return (
			<MessagingServiceProvider>
				<ServicesScreen onboarding onConnected={load} />
			</MessagingServiceProvider>
		);
	}

	return (
		<MessagingServiceProvider>
			<UnifiedApp />
		</MessagingServiceProvider>
	);
}

export function App() {
	return (
		<SoftkeyProvider>
			<FocusProvider>
				<Boot />
			</FocusProvider>
		</SoftkeyProvider>
	);
}
