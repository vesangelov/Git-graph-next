/**
 * Checks for values the webview sends to the host. The webview renders
 * repository content (commit messages, branch names) and is not trusted to
 * send well-formed values; anything that reaches git's argument list is
 * checked here first. No vscode import, so it is testable in plain Node.
 */
import { FULL_HASH, STAGED, UNCOMMITTED, isFullHash, type ChangeTarget } from '../types.ts';

/** A full commit hash, SHA-1 or SHA-256. */
export const HASH = FULL_HASH;

/**
 * The webview sends commit hashes that end up in git's argument list; it is
 * not trusted to have sent well-formed ones. A target names a known
 * repository, a full commit hash (or the working tree), and a full hash as base.
 */
export function isValidTarget(target: unknown, knownRepos: readonly string[]): target is ChangeTarget {
	if (typeof target !== 'object' || target === null) return false;
	const { repo, hash, base } = target as Record<string, unknown>;
	return (
		typeof repo === 'string' && knownRepos.includes(repo) &&
		typeof hash === 'string' && (HASH.test(hash) || hash === UNCOMMITTED || hash === STAGED) &&
		(base === null || (typeof base === 'string' && (HASH.test(base) || base === STAGED)))
	);
}

/** A ref name from the webview: no option-like or control-character values. */
export function isSafeRefName(value: unknown): value is string {
	return typeof value === 'string' && value !== '' && !value.startsWith('-') && !/[\0-\x1f\x7f]/.test(value);
}

/**
 * A repo-relative path from the webview, as git writes paths: forward
 * slashes, never absolute, never climbing out with `..`. A path that does was
 * not sent by an honest view, and joined onto the repository it would open a
 * file anywhere on disk.
 */
export function isRepoRelativePath(value: unknown): value is string {
	if (typeof value !== 'string' || value === '' || value.includes('\0')) return false;
	if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/.test(value)) return false;
	return !value.split(/[\\/]/).includes('..');
}

/** What a `git-graph-next:` URI names: a file at a revision of a repository. */
export interface RevisionQuery {
	readonly repo: string;
	/** A full commit hash, `STAGED` for the index, or '' for "no such file" (an empty side). */
	readonly revision: string;
	readonly path: string;
}

/**
 * Parses the query of a `git-graph-next:` URI, or returns null when it is not
 * one this extension could have made.
 *
 * The scheme is registered for the whole window, so anything that can get VS
 * Code to open a URI can hand one in; the revision reaches `git show`'s
 * argument list, where `--output=…` would be read as an option. Whether the
 * repository is one the extension knows is for the caller to check.
 */
export function parseRevisionQuery(query: string): RevisionQuery | null {
	let value: unknown;
	try {
		value = JSON.parse(query);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const { repo, revision, path } = value as Record<string, unknown>;
	if (typeof repo !== 'string' || repo === '' || !isRepoRelativePath(path)) return null;
	if (revision !== '' && revision !== STAGED && !isFullHash(revision)) return null;
	return { repo, revision: revision as string, path };
}
