import { basename } from 'node:path';
import type { GitExecutor } from './executor.ts';
import { GitLogReader, needsParentRewriting, type LogRequest } from './log.ts';
import { GitRefReader, type RefsResult } from './refs.ts';
import { rewriteParents } from '../graph/rewrite.ts';
import { UNCOMMITTED, type Commit, type GraphData, type Hash, type LogFilter, type Stash } from '../types.ts';

export interface GraphDataRequest {
	readonly filter: LogFilter;
	readonly maxCommits: number;
	readonly ordering: LogRequest['ordering'];
	readonly onlyFollowFirstParent: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly showUncommittedChanges: boolean;
	readonly showUntrackedFiles: boolean;
	/** Follow the single path in `filter.paths` across renames. */
	readonly followRenames: boolean;
}

/**
 * Counts the entries in `git status --porcelain -z` output.
 *
 * Each entry is `XY path`, NUL-terminated; a rename or copy is followed by one
 * extra NUL-terminated field holding the original path, which must be skipped
 * or every rename would be counted twice.
 */
export function countStatusEntries(stdout: string): number {
	const fields = stdout.split('\0');
	let count = 0;
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.length < 4) continue;
		count++;
		if (field[0] === 'R' || field[0] === 'C') i++;
	}
	return count;
}

/**
 * Inserts stash entries into a list of commits as rows of their own.
 *
 * A stash is really a merge of its base commit, an index commit and sometimes
 * an untracked-files commit; drawing all of that would fill the graph with
 * commits nobody made. Each stash is instead shown as a single row whose only
 * parent is its base, placed by date but never below the base, so the graph
 * stays a valid child-above-parent ordering.
 */
export function insertStashes(commits: readonly Commit[], stashes: readonly Stash[]): Commit[] {
	const result = [...commits];
	// Newest stash first, so equal-date stashes keep their stack order.
	const ordered = [...stashes].sort((a, b) => b.date - a.date || a.index - b.index);

	for (const stash of ordered) {
		const baseIndex = result.findIndex((commit) => commit.hash === stash.baseHash);
		if (baseIndex === -1) continue; // Base not loaded: nothing to attach to.

		let position = baseIndex;
		for (let i = 0; i < baseIndex; i++) {
			if (result[i].hash !== UNCOMMITTED && result[i].committerDate < stash.date) {
				position = i;
				break;
			}
		}
		const [subject, ...bodyLines] = stash.message.split('\n');
		result.splice(position, 0, {
			hash: stash.hash,
			parents: [stash.baseHash],
			author: '',
			authorEmail: '',
			authorDate: stash.date,
			committer: '',
			committerEmail: '',
			committerDate: stash.date,
			subject,
			body: bodyLines.join('\n'),
			stash
		});
	}
	return result;
}

/** The synthetic row standing for changes in the working tree and index. */
export function uncommittedCommit(headHash: Hash, changes: number): Commit {
	const now = Math.floor(Date.now() / 1000);
	return {
		hash: UNCOMMITTED,
		parents: [headHash],
		author: '*',
		authorEmail: '',
		authorDate: now,
		committer: '*',
		committerEmail: '',
		committerDate: now,
		subject: `Uncommitted Changes (${changes})`,
		body: '',
		stash: null
	};
}

/**
 * How far the ancestry walk behind a rewritten (author- or follow-filtered)
 * graph goes. Beyond it, edges trail off instead of reconnecting; the cap
 * keeps a filter on a huge repository from walking its entire history.
 */
const ANCESTRY_LIMIT = 50_000;

/**
 * Drops branch filter entries that no longer exist (deleted, or a remote
 * pruned since the filter was chosen). git would reject the whole command
 * with "bad revision" otherwise.
 */
export function existingBranches(selected: readonly string[], refs: RefsResult): string[] {
	const known = new Set<string>([
		...refs.heads.map((head) => `refs/heads/${head.name}`),
		...refs.remoteHeads.map((remote) => `refs/remotes/${remote.name}`)
	]);
	return selected.filter((ref) => known.has(ref));
}

/**
 * The `git log` request behind a graph request. Shared with history search,
 * which must walk exactly the commits the graph shows, in the same order.
 */
export function toLogRequest(request: GraphDataRequest, refs: RefsResult, headHash: Hash | null): LogRequest {
	return {
		filter: { ...request.filter, branches: existingBranches(request.filter.branches, refs) },
		maxCommits: request.maxCommits,
		ordering: request.ordering,
		onlyFollowFirstParent: request.onlyFollowFirstParent,
		includeCommitsMentionedByReflogs: request.includeCommitsMentionedByReflogs,
		followRenames: request.followRenames,
		includeStashes: false,
		includeHead: headHash !== null
	};
}

/** Loads the complete data set for one repository's graph view. */
export async function loadGraphData(git: GitExecutor, repoPath: string, request: GraphDataRequest): Promise<GraphData> {
	const refReader = new GitRefReader(git, repoPath);
	const logReader = new GitLogReader(git, repoPath);

	const [remotes, state, stashes, status] = await Promise.all([
		refReader.remotes(),
		refReader.readState(),
		refReader.readStashes(),
		request.showUncommittedChanges
			? git.runOrNull(repoPath, [
					'status',
					'--porcelain',
					'-z',
					request.showUntrackedFiles ? '--untracked-files=all' : '--untracked-files=no'
				])
			: Promise.resolve(null)
	]);
	const refs = await refReader.readRefs(remotes);

	const logRequest = toLogRequest(request, refs, state.headHash);
	const { branches } = logRequest.filter;
	const pathFiltered = logRequest.filter.paths.length > 0;
	const rewrite = needsParentRewriting(logRequest);

	// An empty repository has no HEAD commit and `git log` fails on it; that is
	// a state to draw, not an error to report.
	const empty = state.headHash === null && (await hasNoCommits(git, repoPath));
	const [log, ancestry, headInPaths] = await Promise.all([
		empty ? Promise.resolve({ commits: [], moreAvailable: false }) : logReader.read(logRequest),
		rewrite && !empty ? logReader.ancestry(logRequest, ANCESTRY_LIMIT) : Promise.resolve(null),
		// Under a plain path filter, uncommitted changes sit on the newest
		// commit touching those paths, not on HEAD itself.
		pathFiltered && !rewrite && state.headHash !== null
			? git.runOrNull(repoPath, ['log', '-n1', '--format=%H', state.headHash, '--', ...logRequest.filter.paths])
			: Promise.resolve(null)
	]);

	let commits = insertStashes(log.commits, stashes);
	const changes = status !== null ? countStatusEntries(status) : 0;
	const uncommittedParent = pathFiltered && !rewrite ? (headInPaths?.trim() || null) : state.headHash;
	if (changes > 0 && uncommittedParent !== null) {
		commits = [uncommittedCommit(uncommittedParent, changes), ...commits];
	}
	if (ancestry !== null) commits = rewriteParents(commits, ancestry);

	// With a branch selection that leaves out HEAD, the uncommitted row would
	// hang from a commit that is not drawn; leave it out instead.
	if (commits[0]?.hash === UNCOMMITTED && branches.length > 0) {
		const shown = new Set(commits.map((commit) => commit.hash));
		if (!commits[0].parents.every((parent) => shown.has(parent))) commits = commits.slice(1);
	}

	return {
		repo: { path: repoPath, name: basename(repoPath), ...state },
		commits,
		heads: refs.heads,
		remoteHeads: request.filter.showRemoteBranches ? refs.remoteHeads : [],
		tags: request.filter.showTags ? refs.tags : [],
		remoteHeadSymrefs: refs.remoteHeadSymrefs,
		moreAvailable: log.moreAvailable,
		maxCommits: request.maxCommits
	};
}

async function hasNoCommits(git: GitExecutor, repoPath: string): Promise<boolean> {
	const output = await git.runOrNull(repoPath, ['rev-list', '-n1', '--all']);
	return output === null || output.trim() === '';
}
