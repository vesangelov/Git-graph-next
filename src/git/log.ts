import type { GitExecutor } from './executor.ts';
import { isFullHash, type Commit, type Hash, type LogFilter } from '../types.ts';

/**
 * Fields requested from `git log`, in order. They are separated by NUL, which
 * git forbids inside commit messages, author names and paths alike — so unlike
 * a printable delimiter it cannot be forged by repository content.
 */
const LOG_FIELDS = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%s', '%b'] as const;
const LOG_FORMAT = `--format=${LOG_FIELDS.join('%x00')}`;
const FIELDS_PER_COMMIT = LOG_FIELDS.length;

export interface LogRequest {
	readonly filter: LogFilter;
	/** Maximum commits to return. */
	readonly maxCommits: number;
	/** Commit ordering, mapped onto git's --date-order/--topo-order flags. */
	readonly ordering: 'date' | 'author-date' | 'topological';
	readonly onlyFollowFirstParent: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	/** Follow renames. Only valid when the filter names exactly one path. */
	readonly followRenames: boolean;
	/** Include commits reachable only from stash entries. */
	readonly includeStashes: boolean;
	/**
	 * Pass `HEAD` as a starting point. Must be false when HEAD is unborn (an
	 * empty repository, or an orphan branch), where git rejects it outright.
	 * Defaults to true.
	 */
	readonly includeHead?: boolean;
}

export interface LogResult {
	readonly commits: readonly Commit[];
	/** True when git had more commits to give than `maxCommits`. */
	readonly moreAvailable: boolean;
}

/** The ordering flag for a request, shared by `git log` and the ancestry walk. */
function orderingArg(ordering: LogRequest['ordering']): string {
	switch (ordering) {
		case 'author-date':
			return '--author-date-order';
		case 'topological':
			return '--topo-order';
		case 'date':
		default:
			return '--date-order';
	}
}

/**
 * The starting points of the walk: the selected branches, or every branch,
 * remote and tag plus HEAD. Shared with the ancestry walk, which must cover
 * exactly the same history as the log it completes.
 */
export function revisionArgs(request: LogRequest, supportsExclude: boolean): string[] {
	const { filter } = request;
	const args: string[] = [];

	if (filter.branches.length > 0) {
		// An explicit branch selection replaces the ref globs entirely.
		args.push(...filter.branches);
	} else {
		args.push(...refGlobArgs(filter, supportsExclude));
		// HEAD is not covered by --branches when the repository is detached.
		if (request.includeHead !== false) args.push('HEAD');
		if (request.includeCommitsMentionedByReflogs) args.push('--reflog');
		if (request.includeStashes) args.push('--glob=refs/stash');
	}
	return args;
}

/**
 * `--branches` / `--remotes` / `--tags`, each preceded by the exclusions (#360).
 *
 * git applies accumulated `--exclude` patterns to the *next* ref glob option
 * only, then clears them, so they must be repeated before every one. Each
 * pattern matches the name inside that namespace (`feature/*` for a branch,
 * `origin/feature/*` for a remote branch, `nightly-*` for a tag), and `*`
 * crosses `/`.
 */
export function refGlobArgs(filter: Pick<LogFilter, 'excludeGlobs' | 'showRemoteBranches' | 'showTags'>, supportsExclude: boolean): string[] {
	const excludes = supportsExclude ? filter.excludeGlobs.map((glob) => `--exclude=${glob}`) : [];
	const args = [...excludes, '--branches'];
	if (filter.showRemoteBranches) args.push(...excludes, '--remotes');
	if (filter.showTags) args.push(...excludes, '--tags');
	return args;
}

/**
 * True when the request drops commits from the middle of history (by author,
 * message, a followed file, or extra arguments), leaving parents that git does
 * not rewrite.
 * Such results need `rewriteParents` to be drawn as a connected graph.
 */
export function needsParentRewriting(request: LogRequest): boolean {
	const { filter } = request;
	return (
		filter.authors.length > 0 ||
		(filter.grep !== null && filter.grep !== '') ||
		followsRenames(request) ||
		// Extra arguments (#591) such as --no-merges or --since drop commits
		// without git rewriting parents. Rewriting is a no-op when they don't.
		filter.extraArgs.length > 0
	);
}

function followsRenames(request: LogRequest): boolean {
	return request.followRenames && request.filter.paths.length === 1;
}

/**
 * Builds the `git log` argument list for a request.
 *
 * Exported so it can be unit tested without a repository: argument construction
 * is where filter combinations go wrong, and those bugs are invisible in the UI
 * until someone's history silently omits commits.
 */
export function buildLogArgs(request: LogRequest, supportsExclude: boolean): string[] {
	const { filter } = request;
	const args = ['log', LOG_FORMAT, '-z'];

	// Ask for one more commit than needed, so the caller can tell whether more
	// history exists without running a second count command.
	args.push(`-n${request.maxCommits + 1}`, orderingArg(request.ordering));

	if (request.onlyFollowFirstParent) args.push('--first-parent');
	args.push(...revisionArgs(request, supportsExclude));

	if (filter.authors.length > 0) {
		// Author filters are names the user picked or typed, not regular
		// expressions: "John (Work)" must match literally, and case-insensitively.
		// --fixed-strings applies to every limiting pattern, --grep included.
		args.push('--fixed-strings', '--regexp-ignore-case');
		for (const author of filter.authors) args.push(`--author=${author}`);
	}
	if (filter.grep !== null && filter.grep !== '') {
		args.push(`--grep=${filter.grep}`, '--regexp-ignore-case');
	}
	if (filter.since !== null) args.push(`--since=${filter.since}`);
	if (filter.until !== null) args.push(`--until=${filter.until}`);

	args.push(...filter.extraArgs);

	if (filter.paths.length > 0) {
		// With a pathspec, --parents makes git rewrite each commit's parents to
		// the nearest ancestor that also touches the paths, so %P names commits
		// that are in the result and the graph stays connected. --follow does
		// not get this treatment (see needsParentRewriting); it tracks a file
		// across renames but git only accepts it for a single path.
		args.push('--parents');
		if (followsRenames(request)) args.push('--follow');
	}

	// Always end revisions explicitly: a branch named like a file in the
	// working tree is otherwise rejected as an ambiguous argument.
	args.push('--', ...filter.paths);
	return args;
}

/**
 * `git log` arguments listing just the hashes of a request's history, in
 * display order, NUL-separated: the log's own arguments with the format
 * swapped. Used to find where a commit sits in the graph before it is loaded.
 */
export function buildHashListArgs(request: LogRequest, supportsExclude: boolean, limit: number): string[] {
	const args = buildLogArgs({ ...request, maxCommits: limit - 1 }, supportsExclude);
	args[args.indexOf(LOG_FORMAT)] = '--format=%H';
	return args;
}

/**
 * Arguments for the ancestry walk that backs `rewriteParents`: the same
 * history as the log, unfiltered, as `hash parent…` lines.
 */
export function buildAncestryArgs(request: LogRequest, supportsExclude: boolean, limit: number): string[] {
	const args = ['rev-list', '--parents', `-n${limit}`, orderingArg(request.ordering)];
	if (request.onlyFollowFirstParent) args.push('--first-parent');
	args.push(...revisionArgs(request, supportsExclude), '--');
	return args;
}

/** Parses `git rev-list --parents` output into a parent map. */
export function parseAncestry(stdout: string): Map<Hash, Hash[]> {
	const ancestry = new Map<Hash, Hash[]>();
	for (const line of stdout.split('\n')) {
		if (line === '') continue;
		const [hash, ...parents] = line.split(' ');
		ancestry.set(hash, parents);
	}
	return ancestry;
}

/**
 * Parses the NUL-delimited output of `git log` into commits.
 *
 * A trailing partial record is discarded rather than producing a commit with
 * empty fields: truncated output means the process was killed, and half a
 * commit rendered in the graph is worse than one missing row.
 */
export function parseLog(stdout: string): Commit[] {
	if (stdout.length === 0) return [];

	const fields = stdout.split('\0');
	// `git log -z` terminates each record with NUL, leaving a final empty
	// element; and records after the first are prefixed with the newline git
	// writes between entries.
	const commits: Commit[] = [];
	const usableRecords = Math.floor(fields.length / FIELDS_PER_COMMIT);

	for (let record = 0; record < usableRecords; record++) {
		const base = record * FIELDS_PER_COMMIT;
		const hash = fields[base].replace(/^\n/, '');
		if (!isFullHash(hash)) continue;

		const parentField = fields[base + 1];
		commits.push({
			hash,
			parents: parentField.length === 0 ? [] : parentField.split(' '),
			author: fields[base + 2],
			authorEmail: fields[base + 3],
			authorDate: parseInt(fields[base + 4], 10) || 0,
			committer: fields[base + 5],
			committerEmail: fields[base + 6],
			committerDate: parseInt(fields[base + 7], 10) || 0,
			subject: fields[base + 8],
			body: fields[base + 9].replace(/\n+$/, ''),
			stash: null
		});
	}

	return commits;
}

/** Reads commits for a repository. */
export class GitLogReader {
	constructor(
		private readonly git: GitExecutor,
		private readonly repoPath: string
	) {}

	async read(request: LogRequest): Promise<LogResult> {
		const args = buildLogArgs(request, this.git.atLeast(1, 9));
		const stdout = await this.git.run(this.repoPath, args);
		const commits = parseLog(stdout);

		if (commits.length > request.maxCommits) {
			return { commits: commits.slice(0, request.maxCommits), moreAvailable: true };
		}
		return { commits, moreAvailable: false };
	}

	/**
	 * Parents of the first `limit` commits of the request's history, ignoring
	 * its commit-limiting filters. Used to reconnect a filtered graph.
	 */
	async ancestry(request: LogRequest, limit: number): Promise<Map<Hash, Hash[]>> {
		const stdout = await this.git.run(this.repoPath, buildAncestryArgs(request, this.git.atLeast(1, 9), limit));
		return parseAncestry(stdout);
	}

	/** Resolves a revision to a full hash, or null when it does not exist. */
	async resolve(revision: string): Promise<Hash | null> {
		const output = await this.git.runOrNull(this.repoPath, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
		const hash = output?.trim() ?? '';
		return isFullHash(hash) ? hash : null;
	}
}
