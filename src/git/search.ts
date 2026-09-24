import type { GitExecutor } from './executor.ts';
import { buildHashListArgs, buildLogArgs, parseLog, type LogRequest } from './log.ts';
import { GitRefReader, type RefsResult } from './refs.ts';
import { toLogRequest, type GraphDataRequest } from './graphData.ts';
import { matchesQuery, type SearchQuery, type SearchRef } from '../search/query.ts';
import { isFullHash, type Commit, type Hash } from '../types.ts';

/** How deep into history a search looks. Past this, a match is reported as not found. */
const ORDER_LIMIT = 200_000;
/** Candidates fetched per git query before exact matching. */
const CANDIDATE_LIMIT = 5_000;

export interface HistoryMatch {
	readonly hash: Hash;
	/** Index among the graph's log commits (stash and uncommitted rows excluded). */
	readonly position: number;
}

/** Ref names by the commit they point at, in the matcher's terms. */
export function refsByHash(refs: RefsResult): Map<Hash, SearchRef[]> {
	const map = new Map<Hash, SearchRef[]>();
	const add = (hash: Hash, ref: SearchRef) => {
		const list = map.get(hash);
		if (list === undefined) map.set(hash, [ref]);
		else list.push(ref);
	};
	for (const head of refs.heads) add(head.hash, { name: head.name, kind: 'branch' });
	for (const remote of refs.remoteHeads) add(remote.hash, { name: remote.name, kind: 'remote' });
	for (const tag of refs.tags) add(tag.hash, { name: tag.name, kind: 'tag' });
	return map;
}

/**
 * `git log` arguments that narrow history to a superset of the query's
 * matches. They only need to be necessary conditions: every candidate is
 * checked with `matchesQuery` afterwards, so over-matching is harmless and
 * under-matching is the only thing to avoid.
 */
export function narrowingArgs(query: SearchQuery, freeTextIn: 'message' | 'author' | null): string[] {
	const args: string[] = [];
	for (const term of query.author) args.push(`--author=${term}`);
	for (const term of query.committer) args.push(`--committer=${term}`);
	const greps = [...query.message, ...(freeTextIn === 'message' ? query.text : [])];
	for (const term of greps) args.push(`--grep=${term}`);
	if (greps.length > 1) args.push('--all-match');
	if (freeTextIn === 'author') for (const term of query.text) args.push(`--author=${term}`);
	// Committer dates are never earlier than author dates, so "committed on or
	// after X" is necessary for either reading of the bound. Not so for the
	// upper bound, which is left to the exact check.
	if (query.after !== null) args.push(`--since=${new Date(query.after * 1000).toISOString()}`);
	if (args.length > 0) args.unshift('--fixed-strings', '--regexp-ignore-case');
	return args;
}

/**
 * Finds the first commit matching `query` at or after `fromPosition` in the
 * graph's order, anywhere in history rather than only among loaded commits.
 */
export async function searchHistory(
	git: GitExecutor,
	repo: string,
	request: GraphDataRequest,
	query: SearchQuery,
	fromPosition: number,
	useCommitDate: boolean
): Promise<HistoryMatch | null> {
	const refReader = new GitRefReader(git, repo);
	const [remotes, state] = await Promise.all([refReader.remotes(), refReader.readState()]);
	const refs = await refReader.readRefs(remotes);
	const logRequest = toLogRequest(request, refs, state.headHash);
	const refMap = refsByHash(refs);
	const supportsExclude = git.atLeast(1, 9);

	const orderOutput = await git.run(repo, buildHashListArgs(logRequest, supportsExclude, ORDER_LIMIT));
	const position = new Map<Hash, number>();
	for (const field of orderOutput.split('\0')) {
		const hash = field.replace(/^\n/, '');
		if (hash !== '' && !position.has(hash)) position.set(hash, position.size);
	}

	const candidates = await findCandidates(git, repo, logRequest, query, refMap, supportsExclude);
	let best: HistoryMatch | null = null;
	for (const commit of candidates) {
		const at = position.get(commit.hash);
		if (at === undefined || at < fromPosition || (best !== null && at >= best.position)) continue;
		if (matchesQuery(query, commit, refMap.get(commit.hash) ?? [], useCommitDate)) best = { hash: commit.hash, position: at };
	}
	return best;
}

async function findCandidates(
	git: GitExecutor,
	repo: string,
	logRequest: LogRequest,
	query: SearchQuery,
	refMap: Map<Hash, SearchRef[]>,
	supportsExclude: boolean
): Promise<Commit[]> {
	const log = async (extraArgs: string[]): Promise<Commit[]> => {
		const request = { ...logRequest, maxCommits: CANDIDATE_LIMIT, filter: { ...logRequest.filter, extraArgs: [...logRequest.filter.extraArgs, ...extraArgs] } };
		return parseLog(await git.run(repo, buildLogArgs(request, supportsExclude)));
	};

	// Ref and hash terms pin the match to specific commits: read just those.
	const refTerms = [...query.branch, ...query.tag, ...query.ref];
	if (refTerms.length > 0 || query.hash.length > 0) {
		const pinned = new Set<Hash>();
		for (const [hash, refs] of refMap) {
			if (refs.some((ref) => refTerms.some((term) => ref.name.toLowerCase().includes(term)))) pinned.add(hash);
		}
		for (const prefix of query.hash) {
			const resolved = (await git.runOrNull(repo, ['rev-parse', '--verify', '--quiet', `${prefix}^{commit}`]))?.trim();
			if (isFullHash(resolved)) pinned.add(resolved);
		}
		return readCommits(git, repo, [...pinned]);
	}

	if (query.text.length === 0) return log(narrowingArgs(query, null));

	// Free text may sit in the message, the author, or a ref name / hash prefix.
	const pinned = new Set<Hash>();
	for (const [hash, refs] of refMap) {
		if (query.text.every((term) => refs.some((ref) => ref.name.toLowerCase().includes(term)))) pinned.add(hash);
	}
	const [inMessage, byAuthor, inRefs] = await Promise.all([
		log(narrowingArgs(query, 'message')),
		log(narrowingArgs(query, 'author')),
		readCommits(git, repo, [...pinned])
	]);
	// A hex word may be a hash prefix; those are only found by asking.
	const hexWord = query.text.length === 1 && /^[0-9a-f]{4,64}$/.test(query.text[0]) ? query.text[0] : null;
	const byHash = hexWord === null ? [] : await readCommits(git, repo, [(await git.runOrNull(repo, ['rev-parse', '--verify', '--quiet', `${hexWord}^{commit}`]))?.trim() ?? '']);
	return [...inMessage, ...byAuthor, ...inRefs, ...byHash];
}

/** Reads specific commits, in no particular order. Unknown hashes are skipped. */
async function readCommits(git: GitExecutor, repo: string, hashes: readonly string[]): Promise<Commit[]> {
	const valid = hashes.filter(isFullHash);
	if (valid.length === 0) return [];
	const args = buildLogArgs(
		{
			filter: { paths: [], authors: [], branches: valid, excludeGlobs: [], showRemoteBranches: false, showTags: false, grep: null, since: null, until: null, extraArgs: ['--no-walk=unsorted'] },
			maxCommits: valid.length,
			ordering: 'date',
			onlyFollowFirstParent: false,
			includeCommitsMentionedByReflogs: false,
			followRenames: false,
			includeStashes: false
		},
		false
	);
	return parseLog((await git.runOrNull(repo, args)) ?? '');
}
