import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useState } from 'preact/hooks';
import { installedServices, serviceById } from './registry';
import type { MessagingService, ServiceId, ServiceStatus } from './contracts';

type ContextValue = {
	services: MessagingService[];
	statuses: ServiceStatus[];
	ready: boolean;
	refreshStatuses: () => Promise<void>;
	serviceFor: (id: ServiceId) => MessagingService;
};

const ServiceContext = createContext<ContextValue | null>(null);

export function MessagingServiceProvider({ children }: { children: ComponentChildren }) {
	const availableServices = useMemo(() => installedServices(), []);
	const [statuses, setStatuses] = useState<ServiceStatus[]>([]);
	const [ready, setReady] = useState(false);
	const services = useMemo(
		() =>
			availableServices.filter((service) =>
				statuses.some((status) => status.id === service.id && status.connected && status.ready),
			),
		[availableServices, statuses],
	);

	const refreshStatuses = async () => {
		const next = await Promise.all(
			availableServices.map(async (service) => {
				try {
					return await service.getStatus();
				} catch {
					return {
						id: service.id,
						label: service.label,
						connected: false,
						ready: false,
					};
				}
			}),
		);
		setStatuses(next);
		setReady(true);
	};

	useEffect(() => {
		void refreshStatuses();
	}, [availableServices]);

	useEffect(() => {
		// Keep checking only services which are linked but whose daemon is still booting.
		// This avoids a stale "Service starting" state after the app shell has loaded.
		if (!statuses.some((status) => status.connected && !status.ready)) return;
		const timer = window.setTimeout(() => void refreshStatuses(), 2_000);
		return () => window.clearTimeout(timer);
	}, [statuses]);

	return (
		<ServiceContext.Provider
			value={{
				services,
				statuses,
				ready,
				refreshStatuses,
				serviceFor: serviceById,
			}}
		>
			{children}
		</ServiceContext.Provider>
	);
}

export function useMessagingServices(): ContextValue {
	const context = useContext(ServiceContext);
	if (!context) throw new Error('useMessagingServices must be used inside MessagingServiceProvider');

	return context;
}
