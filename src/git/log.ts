import type { GitExecutor } from './executor.ts';
import type { Commit, Hash, LogFilter } from '../types.ts';

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
	args.push(`-n${request.maxCommits + 1}`);

	switch (request.ordering) {
		case 'date':
			args.push('--date-order');
			break;
		case 'author-date':
			args.push('--author-date-order');
			break;
		case 'topological':
			args.push('--topo-order');
			break;
	}

	if (request.onlyFollowFirstParent) args.push('--first-parent');

	// --exclude only affects the ref globs that follow it, so it must precede
	// --all / --branches / --remotes rather than trail them.
	if (supportsExclude) {
		for (const glob of filter.excludeGlobs) args.push(`--exclude=${glob}`);
	}

	if (filter.branches.length > 0) {
		// An explicit branch selection replaces the ref globs entirely.
		args.push(...filter.branches);
	} else {
		args.push('--branches');
		if (filter.showRemoteBranches) args.push('--remotes');
		if (filter.showTags) args.push('--tags');
		// HEAD is not covered by --branches when the repository is detached.
		if (request.includeHead !== false) args.push('HEAD');
		if (request.includeCommitsMentionedByReflogs) args.push('--reflog');
		if (request.includeStashes) args.push('--glob=refs/stash');
	}

	for (const author of filter.authors) args.push(`--author=${author}`);
	if (filter.grep !== null && filter.grep !== '') {
		args.push(`--grep=${filter.grep}`, '--regexp-ignore-case');
	}
	if (filter.since !== null) args.push(`--since=${filter.since}`);
	if (filter.until !== null) args.push(`--until=${filter.until}`);

	args.push(...filter.extraArgs);

	if (filter.paths.length > 0) {
		// --follow tracks a file across renames but git only accepts it for a
		// single path, so it is the caller's job to request it appropriately.
		if (request.followRenames && filter.paths.length === 1) args.push('--follow');
		args.push('--', ...filter.paths);
	}

	return args;
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
		if (!/^[0-9a-f]{40}$/.test(hash)) continue;

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

	/** Resolves a revision to a full hash, or null when it does not exist. */
	async resolve(revision: string): Promise<Hash | null> {
		const output = await this.git.runOrNull(this.repoPath, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
		const hash = output?.trim() ?? '';
		return /^[0-9a-f]{40}$/.test(hash) ? hash : null;
	}
}
