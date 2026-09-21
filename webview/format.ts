import type { ViewConfig } from '../src/view/protocol.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

/** Formats a Unix timestamp (seconds) per the `date.format` setting, in local time. */
export function formatDate(seconds: number, format: ViewConfig['dateFormat'], now = Date.now()): string {
	const date = new Date(seconds * 1000);
	const y = date.getFullYear();
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	switch (format) {
		case 'Date Only':
			return `${date.getDate()} ${MONTHS[date.getMonth()]} ${y}`;
		case 'ISO Date & Time':
			return `${y}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
		case 'ISO Date Only':
			return `${y}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
		case 'Relative':
			return relativeTime(seconds, now);
		case 'Date & Time':
		default:
			return `${date.getDate()} ${MONTHS[date.getMonth()]} ${y} ${time}`;
	}
}

/** Full, unambiguous form for tooltips. */
export function formatDateLong(seconds: number): string {
	return new Date(seconds * 1000).toString();
}

const UNITS: readonly [number, string][] = [
	[365 * 24 * 3600, 'year'],
	[30 * 24 * 3600, 'month'],
	[7 * 24 * 3600, 'week'],
	[24 * 3600, 'day'],
	[3600, 'hour'],
	[60, 'minute'],
	[1, 'second']
];

export function relativeTime(seconds: number, now = Date.now()): string {
	const diff = Math.round(now / 1000 - seconds);
	if (diff < 0) return 'in the future';
	for (const [size, name] of UNITS) {
		if (diff >= size) {
			const count = Math.floor(diff / size);
			return `${count} ${name}${count === 1 ? '' : 's'} ago`;
		}
	}
	return 'just now';
}

export function shortHash(hash: string): string {
	return hash.slice(0, 8);
}
