/**
 * Checks for values the webview sends to the host. The webview renders
 * repository content (commit messages, branch names) and is not trusted to
 * send well-formed values; anything that reaches git's argument list is
 * checked here first. No vscode import, so it is testable in plain Node.
 */
import { UNCOMMITTED, type ChangeTarget } from '../types.ts';

export const HASH = /^[0-9a-f]{40}$/;

/**
 * The webview sends commit hashes that end up in git's argument list; it is
 * not trusted to have sent well-formed ones. A target names a known
 * repository, a 40-hex commit (or the working tree), and a 40-hex base.
 */
export function isValidTarget(target: unknown, knownRepos: readonly string[]): target is ChangeTarget {
	if (typeof target !== 'object' || target === null) return false;
	const { repo, hash, base } = target as Record<string, unknown>;
	return (
		typeof repo === 'string' && knownRepos.includes(repo) &&
		typeof hash === 'string' && (HASH.test(hash) || hash === UNCOMMITTED) &&
		(base === null || (typeof base === 'string' && HASH.test(base)))
	);
}

/** A ref name from the webview: no option-like or control-character values. */
export function isSafeRefName(value: unknown): value is string {
	return typeof value === 'string' && value !== '' && !value.startsWith('-') && !/[\0-\x1f\x7f]/.test(value);
}
