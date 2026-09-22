import { createHash } from 'node:crypto';

const SIZE = 36;

/**
 * Where an author's avatar comes from. GitHub's no-reply addresses
 * (`12345+name@users.noreply.github.com`) name the account; everyone else is
 * looked up on Gravatar by the hash of their address, with no substitute
 * image (`d=404`), so an author without one keeps the plain name.
 */
export function avatarUrl(email: string): string {
	const address = email.trim().toLowerCase();
	const github = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(address);
	if (github !== null) return `https://github.com/${encodeURIComponent(github[1])}.png?size=${SIZE}`;
	const hash = createHash('md5').update(address).digest('hex');
	return `https://www.gravatar.com/avatar/${hash}?s=${SIZE}&d=404`;
}
