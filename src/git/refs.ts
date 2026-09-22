import type { GitExecutor } from './executor.ts';
import { PendingOperation, RefType, type Hash, type HeadRef, type Ref, type RemoteHeadRef, type RepoState, type Stash, type TagRef } from '../types.ts';

/**
 * Ref fields, NUL-separated.
 *
 * `for-each-ref` spells a NUL as `%00` — note that `git log` and `git stash
 * list` spell the same byte `%x00` instead, so these formats are not
 * interchangeable. The trailing separator matters too: without it the last
 * field of one record runs into the first field of the next, separated only by
 * the newline git writes between records, and every record after the first is
 * parsed one field out of step.
 */
const REF_FIELDS = [
	'%(refname)',
	'%(objectname)',
	'%(objecttype)',
	'%(*objectname)',
	'%(upstream:short)',
	'%(upstream:track)',
	'%(symref)'
] as const;
const FIELDS_PER_REF = REF_FIELDS.length;

/**
 * The same seven fields, split by what they cost. `%(objecttype)` and
 * `%(*objectname)` make git open every ref's object, which only tags need:
 * with 20k branches that alone is a third of a second. Branches get those two
 * fields empty; tags get the upstream fields empty. `parseRefs` reads both.
 */
const BRANCH_FORMAT = `--format=%(refname)%00%(objectname)%00%00%00%(upstream:short)%00%(upstream:track)%00%(symref)%00`;
const TAG_FORMAT = `--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%00%00%00`;

export interface RefsResult {
	readonly heads: readonly HeadRef[];
	readonly remoteHeads: readonly RemoteHeadRef[];
	readonly tags: readonly TagRef[];
	/** Remote name to the branch its HEAD points at, e.g. `origin` → `origin/main`. */
	readonly remoteHeadSymrefs: Readonly<Record<string, string>>;
}

/**
 * Parses `[ahead 3, behind 1]` as produced by `%(upstream:track)`.
 *
 * With LC_ALL=C the wording is fixed, but the shape varies: either half can be
 * absent, and a deleted upstream reports `[gone]`. Anything unrecognised yields
 * nulls rather than a misleading zero.
 */
export function parseUpstreamTrack(track: string): { ahead: number | null; behind: number | null } {
	if (track === '' || track.includes('gone')) return { ahead: null, behind: null };
	const ahead = /ahead (\d+)/.exec(track);
	const behind = /behind (\d+)/.exec(track);
	if (ahead === null && behind === null) {
		// `[]` or an empty track with an upstream set means fully in sync.
		return { ahead: 0, behind: 0 };
	}
	return {
		ahead: ahead !== null ? parseInt(ahead[1], 10) : 0,
		behind: behind !== null ? parseInt(behind[1], 10) : 0
	};
}

/** Splits a remote-tracking ref like `origin/feature/x` into remote and rest. */
export function splitRemoteRef(shortName: string, remotes: readonly string[]): { remote: string; branch: string } | null {
	// Longest remote name first, so `origin/sub` does not shadow a remote
	// literally called `origin/sub` when both exist.
	for (const remote of [...remotes].sort((a, b) => b.length - a.length)) {
		if (shortName === remote) return null;
		if (shortName.startsWith(`${remote}/`)) {
			return { remote, branch: shortName.slice(remote.length + 1) };
		}
	}
	return null;
}

export function parseRefs(stdout: string, remotes: readonly string[]): RefsResult {
	const heads: HeadRef[] = [];
	const remoteHeads: RemoteHeadRef[] = [];
	const tags: TagRef[] = [];
	const remoteHeadSymrefs: Record<string, string> = {};

	const fields = stdout.split('\0');
	const records = Math.floor(fields.length / FIELDS_PER_REF);

	for (let record = 0; record < records; record++) {
		const base = record * FIELDS_PER_REF;
		const refname = fields[base].replace(/^\n/, '');
		const objectname = fields[base + 1];
		const objecttype = fields[base + 2];
		const dereferenced = fields[base + 3];
		const upstream = fields[base + 4];
		const track = fields[base + 5];
		const symref = fields[base + 6];

		if (refname.startsWith('refs/heads/')) {
			const { ahead, behind } = parseUpstreamTrack(track);
			heads.push({
				type: RefType.Head,
				name: refname.slice('refs/heads/'.length),
				hash: objectname,
				upstream: upstream === '' ? null : upstream,
				ahead: upstream === '' ? null : ahead,
				behind: upstream === '' ? null : behind
			});
		} else if (refname.startsWith('refs/remotes/')) {
			const shortName = refname.slice('refs/remotes/'.length);
			const split = splitRemoteRef(shortName, remotes);
			if (split === null) continue;
			if (split.branch === 'HEAD') {
				// `origin/HEAD` is a symbolic ref naming the remote's default
				// branch; it is not a branch of its own and must not be drawn.
				if (symref !== '') {
					remoteHeadSymrefs[split.remote] = symref.replace(/^refs\/remotes\//, '');
				}
				continue;
			}
			remoteHeads.push({ type: RefType.RemoteHead, name: shortName, remote: split.remote, hash: objectname });
		} else if (refname.startsWith('refs/tags/')) {
			const annotated = objecttype === 'tag';
			tags.push({
				type: RefType.Tag,
				name: refname.slice('refs/tags/'.length),
				// An annotated tag's own object id is not a commit; the graph
				// must attach the label to the commit it dereferences to.
				hash: annotated && dereferenced !== '' ? dereferenced : objectname,
				annotated
			});
		}
	}

	return { heads, remoteHeads, tags, remoteHeadSymrefs };
}

/** Reads refs, stashes and working-tree state for one repository. */
export class GitRefReader {
	constructor(
		private readonly git: GitExecutor,
		private readonly repoPath: string
	) {}

	async remotes(): Promise<string[]> {
		const output = await this.git.run(this.repoPath, ['remote']);
		return output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
	}

	async readRefs(remotes: readonly string[]): Promise<RefsResult> {
		const [branches, tags] = await Promise.all([
			this.git.run(this.repoPath, ['for-each-ref', BRANCH_FORMAT, 'refs/heads', 'refs/remotes']),
			this.git.run(this.repoPath, ['for-each-ref', TAG_FORMAT, 'refs/tags'])
		]);
		return parseRefs(branches + tags, remotes);
	}

	/**
	 * Reads the stash list. Stashes are commits that no branch points at, so
	 * they must be collected separately or they vanish from the graph.
	 */
	async readStashes(): Promise<Stash[]> {
		// `git stash list` takes a log format, where NUL is written `%x00`;
		// `%00` would be emitted as those three literal characters.
		const output = await this.git.runOrNull(this.repoPath, [
			'stash',
			'list',
			'--format=%gd%x00%H%x00%P%x00%at%x00%gs'
		]);
		if (output === null) return [];

		const stashes: Stash[] = [];
		for (const line of output.split('\n')) {
			if (line.length === 0) continue;
			const parts = line.split('\0');
			if (parts.length < 5) continue;
			const parents = parts[2].split(' ').filter((p) => p.length > 0);
			const index = /^stash@\{(\d+)\}$/.exec(parts[0]);
			stashes.push({
				index: index !== null ? parseInt(index[1], 10) : stashes.length,
				hash: parts[1],
				baseHash: parents[0] ?? '',
				selector: parts[0],
				message: parts[4],
				date: parseInt(parts[3], 10) || 0
			});
		}
		return stashes;
	}

	/** Reads which branch is checked out, and whether an operation is in progress. */
	async readState(): Promise<Omit<RepoState, 'path' | 'name'>> {
		const [headName, headHash, pending] = await Promise.all([
			this.git.runOrNull(this.repoPath, ['symbolic-ref', '--short', '-q', 'HEAD']),
			this.git.runOrNull(this.repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD']),
			this.readPendingOperation()
		]);

		const head = headName?.trim() ?? '';
		const hash = headHash?.trim() ?? '';
		return {
			head: head === '' ? null : head,
			headHash: /^[0-9a-f]{40}$/.test(hash) ? hash : null,
			isDetached: head === '',
			pendingOperation: pending
		};
	}

	/**
	 * Detects an interrupted merge, rebase, cherry-pick, revert or bisect.
	 *
	 * These are read from the git directory rather than inferred, so the view
	 * can offer `--continue` / `--abort` instead of leaving the user stuck in a
	 * state the graph does not acknowledge.
	 */
	private async readPendingOperation(): Promise<PendingOperation | null> {
		const gitDir = (await this.git.runOrNull(this.repoPath, ['rev-parse', '--absolute-git-dir']))?.trim();
		if (gitDir === undefined || gitDir === '') return null;

		const { existsSync } = await import('node:fs');
		const { join } = await import('node:path');
		const has = (...parts: string[]) => existsSync(join(gitDir, ...parts));

		// `git am` and the old rebase backend share rebase-apply; am marks it.
		if (has('rebase-apply', 'applying')) return PendingOperation.Am;
		if (has('rebase-merge') || has('rebase-apply')) return PendingOperation.Rebase;
		if (has('MERGE_HEAD')) return PendingOperation.Merge;
		if (has('CHERRY_PICK_HEAD')) return PendingOperation.CherryPick;
		if (has('REVERT_HEAD')) return PendingOperation.Revert;
		if (has('BISECT_LOG')) return PendingOperation.Bisect;
		return null;
	}

	/** Returns the hashes of commits that are stash entries, for graph inclusion. */
	static stashHashes(stashes: readonly Stash[]): Set<Hash> {
		return new Set(stashes.map((stash) => stash.hash));
	}

	/** Type guard used by the view when narrowing a mixed ref list. */
	static isHead(ref: Ref): ref is HeadRef {
		return ref.type === RefType.Head;
	}
}
