import type { ServiceId } from '../services/contracts';
import styles from './ServiceIcon.module.scss';

const assetByService: Record<ServiceId, string> = {
	signal: './services/signal.png',
	telegram: './services/telegram.png',
	whatsapp: './services/whatsapp.png',
};

export function ServiceIcon({
	service,
	className = '',
}: {
	service: ServiceId;
	className?: string;
}) {
	return (
		<img
			class={`${styles.icon} ${className}`}
			src={assetByService[service]}
			alt=""
			aria-hidden="true"
		/>
	);
}
