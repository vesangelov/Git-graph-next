import type { Commit } from '../types.ts';

/**
 * The commit search language (#147), modelled on GitHub's commit search:
 *
 *   fix typo                  every word somewhere in the commit
 *   "fix typo"                the exact phrase
 *   author:alice              author name or e-mail contains "alice"
 *   committer:bob             likewise for the committer
 *   message:"null check"      subject or body contains the phrase
 *   hash:3f2a                 hash starts with 3f2a
 *   branch:feat  tag:v1  ref:release   a branch / tag / any ref name contains it
 *   after:2024-01-01  before:2024-02   date bounds (also date:>… date:<…)
 *
 * All terms must match (AND). Matching is case-insensitive and literal: no
 * term is a regular expression, so "C++" or "(wip)" search for exactly that.
 *
 * Shared by the webview (searching loaded commits) and the host (searching the
 * rest of history), so both agree on what a match is. No DOM, no Node.
 */
export interface SearchQuery {
	/** Words or phrases that may match any field. */
	readonly text: readonly string[];
	readonly author: readonly string[];
	readonly committer: readonly string[];
	readonly message: readonly string[];
	readonly hash: readonly string[];
	readonly branch: readonly string[];
	readonly tag: readonly string[];
	readonly ref: readonly string[];
	/** Inclusive lower bound, Unix seconds. */
	readonly after: number | null;
	/** Exclusive upper bound, Unix seconds. */
	readonly before: number | null;
}

export type RefKind = 'branch' | 'remote' | 'tag' | 'stash';

/** A ref name as the matcher sees it. */
export interface SearchRef {
	readonly name: string;
	readonly kind: RefKind;
}

const KEYS: Record<string, keyof SearchQuery | 'date'> = {
	author: 'author',
	committer: 'committer',
	message: 'message',
	msg: 'message',
	hash: 'hash',
	commit: 'hash',
	branch: 'branch',
	tag: 'tag',
	ref: 'ref',
	after: 'after',
	since: 'after',
	before: 'before',
	until: 'before',
	date: 'date',
	'author-date': 'date',
	'committer-date': 'date'
};

/**
 * Splits a query into tokens, keeping quoted phrases (also after a `key:`)
 * together: `author:"Jane Doe" fix` → [`author:Jane Doe`, `fix`].
 */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	const pattern = /(\S*?)"([^"]*)"?|(\S+)/g;
	for (const match of input.matchAll(pattern)) {
		const token = match[3] ?? `${match[1]}${match[2]}`;
		if (token !== '') tokens.push(token);
	}
	return tokens;
}

/**
 * Parses a date bound: `2024`, `2024-03` or `2024-03-15`, in local time.
 * `end` gives the first instant after the period, for exclusive upper bounds
 * that still include the named day ("before:2024-03-15" excludes the 15th;
 * "date:<=2024-03-15" includes it).
 */
export function parseDate(text: string, end = false): number | null {
	const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(text.trim());
	if (match === null) return null;
	const year = Number(match[1]);
	const month = match[2] !== undefined ? Number(match[2]) - 1 : null;
	const day = match[3] !== undefined ? Number(match[3]) : null;
	if (month !== null && (month < 0 || month > 11)) return null;
	if (day !== null && (day < 1 || day > 31)) return null;
	let date: Date;
	if (!end) date = new Date(year, month ?? 0, day ?? 1);
	else if (day !== null) date = new Date(year, month!, day + 1);
	else if (month !== null) date = new Date(year, month + 1, 1);
	else date = new Date(year + 1, 0, 1);
	return Math.floor(date.getTime() / 1000);
}

/** Parses a query. Returns null for a query with no terms. */
export function parseQuery(input: string): SearchQuery | null {
	const query = {
		text: [] as string[], author: [] as string[], committer: [] as string[], message: [] as string[],
		hash: [] as string[], branch: [] as string[], tag: [] as string[], ref: [] as string[],
		after: null as number | null, before: null as number | null
	};
	const tighten = (after: number | null, before: number | null) => {
		if (after !== null) query.after = query.after === null ? after : Math.max(query.after, after);
		if (before !== null) query.before = query.before === null ? before : Math.min(query.before, before);
	};

	for (const token of tokenize(input)) {
		const colon = token.indexOf(':');
		const key = colon > 0 ? KEYS[token.slice(0, colon).toLowerCase()] : undefined;
		const value = colon > 0 ? token.slice(colon + 1) : '';
		// Unknown prefixes ("fix:", "http://…") and empty values are plain text.
		if (key === undefined || value === '') {
			query.text.push(token.toLowerCase());
			continue;
		}
		switch (key) {
			case 'after':
				tighten(parseDate(value), null);
				break;
			case 'before':
				tighten(null, parseDate(value));
				break;
			case 'date': {
				const comparison = /^(>=|<=|>|<)?(.*)$/.exec(value)!;
				const [op, when] = [comparison[1] ?? '', comparison[2]];
				if (op === '>') tighten(parseDate(when, true), null);
				else if (op === '>=') tighten(parseDate(when), null);
				else if (op === '<') tighten(null, parseDate(when));
				else if (op === '<=') tighten(null, parseDate(when, true));
				else tighten(parseDate(when), parseDate(when, true)); // date:2024-03 = within March
				break;
			}
			default:
				(query[key] as string[]).push(value.toLowerCase());
		}
	}

	const empty =
		query.after === null && query.before === null &&
		(['text', 'author', 'committer', 'message', 'hash', 'branch', 'tag', 'ref'] as const).every((k) => query[k].length === 0);
	return empty ? null : query;
}

/** Terms worth highlighting in a commit's subject. */
export function highlightTerms(query: SearchQuery): string[] {
	return [...query.text, ...query.message].filter((term) => term.length > 0);
}

const includes = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle);

/**
 * True when the commit satisfies every term. `useCommitDate` picks which of
 * the commit's dates the date bounds apply to, matching the date shown.
 */
export function matchesQuery(query: SearchQuery, commit: Commit, refs: readonly SearchRef[], useCommitDate = false): boolean {
	const message = `${commit.subject}\n${commit.body}`;
	const refsOf = (kinds: readonly RefKind[]) => refs.filter((ref) => kinds.includes(ref.kind));
	const anyRef = (kinds: readonly RefKind[], needle: string) => refsOf(kinds).some((ref) => includes(ref.name, needle));

	for (const term of query.text) {
		const hit =
			includes(message, term) ||
			includes(commit.author, term) ||
			includes(commit.authorEmail, term) ||
			commit.hash.startsWith(term) ||
			anyRef(['branch', 'remote', 'tag', 'stash'], term);
		if (!hit) return false;
	}
	for (const term of query.author) if (!includes(commit.author, term) && !includes(commit.authorEmail, term)) return false;
	for (const term of query.committer) if (!includes(commit.committer, term) && !includes(commit.committerEmail, term)) return false;
	for (const term of query.message) if (!includes(message, term)) return false;
	for (const term of query.hash) if (!commit.hash.startsWith(term)) return false;
	for (const term of query.branch) if (!anyRef(['branch', 'remote'], term)) return false;
	for (const term of query.tag) if (!anyRef(['tag'], term)) return false;
	for (const term of query.ref) if (!anyRef(['branch', 'remote', 'tag', 'stash'], term)) return false;

	const date = useCommitDate ? commit.committerDate : commit.authorDate;
	if (query.after !== null && date < query.after) return false;
	if (query.before !== null && date >= query.before) return false;
	return true;
}
