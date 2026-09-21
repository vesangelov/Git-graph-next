import { basename } from 'node:path';
import type { GitExecutor } from './executor.ts';
import { GitLogReader, type LogRequest } from './log.ts';
import { GitRefReader } from './refs.ts';
import { UNCOMMITTED, type Commit, type GraphData, type Hash, type LogFilter, type Stash } from '../types.ts';

export interface GraphDataRequest {
	readonly filter: LogFilter;
	readonly maxCommits: number;
	readonly ordering: LogRequest['ordering'];
	readonly onlyFollowFirstParent: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly showUncommittedChanges: boolean;
	readonly showUntrackedFiles: boolean;
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

	const [refs, log] = await Promise.all([
		refReader.readRefs(remotes),
		// An empty repository has no HEAD commit and `git log` fails on it;
		// that is a state to draw, not an error to report.
		state.headHash === null && (await hasNoCommits(git, repoPath))
			? Promise.resolve({ commits: [], moreAvailable: false })
			: logReader.read({
					filter: request.filter,
					maxCommits: request.maxCommits,
					ordering: request.ordering,
					onlyFollowFirstParent: request.onlyFollowFirstParent,
					includeCommitsMentionedByReflogs: request.includeCommitsMentionedByReflogs,
					followRenames: false,
					includeStashes: false,
					includeHead: state.headHash !== null
				})
	]);

	let commits = insertStashes(log.commits, stashes);
	const changes = status !== null ? countStatusEntries(status) : 0;
	if (changes > 0 && state.headHash !== null) {
		commits = [uncommittedCommit(state.headHash, changes), ...commits];
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
