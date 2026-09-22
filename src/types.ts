/**
 * Types shared between the extension host and the webview. Anything declared
 * here crosses a postMessage boundary, so it must stay JSON-serialisable:
 * no Date, no Map, no class instances.
 */

/** A 40-character lowercase hex object id. */
export type Hash = string;

/** The synthetic hash used for the Uncommitted Changes row. */
export const UNCOMMITTED: Hash = '*'.repeat(40);

export const RefType = {
	Head: 'head',
	RemoteHead: 'remoteHead',
	Tag: 'tag'
} as const;
export type RefType = (typeof RefType)[keyof typeof RefType];

export interface HeadRef {
	readonly type: typeof RefType.Head;
	/** Short name, e.g. `main`. */
	readonly name: string;
	readonly hash: Hash;
	/** `origin/main`, when the local branch tracks a remote branch. */
	readonly upstream: string | null;
	/** Commits ahead of / behind the upstream, or null when there is no upstream. */
	readonly ahead: number | null;
	readonly behind: number | null;
}

export interface RemoteHeadRef {
	readonly type: typeof RefType.RemoteHead;
	/** Full name including the remote, e.g. `origin/main`. */
	readonly name: string;
	readonly remote: string;
	readonly hash: Hash;
}

export interface TagRef {
	readonly type: typeof RefType.Tag;
	readonly name: string;
	readonly hash: Hash;
	/** True for annotated or signed tags, which carry their own object. */
	readonly annotated: boolean;
}

export type Ref = HeadRef | RemoteHeadRef | TagRef;

export interface Stash {
	readonly index: number;
	readonly hash: Hash;
	/** The commit the stash was taken against. */
	readonly baseHash: Hash;
	readonly selector: string;
	readonly message: string;
	readonly date: number;
}

export interface Commit {
	readonly hash: Hash;
	readonly parents: readonly Hash[];
	readonly author: string;
	readonly authorEmail: string;
	/** Unix seconds. */
	readonly authorDate: number;
	readonly committer: string;
	readonly committerEmail: string;
	readonly committerDate: number;
	readonly subject: string;
	readonly body: string;
	/** Populated for the HEAD commit only; see `GitLogReader`. */
	readonly stash: Stash | null;
}

/** One vertical lane of the drawn graph, resolved by the layout pass. */
export interface GraphVertex {
	readonly hash: Hash;
	/** Zero-based column the commit's circle sits on. */
	readonly column: number;
	/** Index into the configured colour list. */
	readonly colour: number;
	/** True when the commit is reachable only from refs that are filtered out. */
	readonly dimmed: boolean;
}

export interface GraphEdge {
	/** Row index of the child commit. */
	readonly fromIndex: number;
	/** Row index of the parent commit, or -1 when the parent was not loaded. */
	readonly toIndex: number;
	readonly fromColumn: number;
	readonly toColumn: number;
	/** The column the edge travels down between the two rows. */
	readonly laneColumn: number;
	readonly colour: number;
	/** True for the edge leaving the Uncommitted Changes row, which is drawn dashed. */
	readonly dashed: boolean;
}

export interface GraphLayout {
	readonly vertices: readonly GraphVertex[];
	readonly edges: readonly GraphEdge[];
	/** Number of columns required, used to size the SVG. */
	readonly width: number;
}

/** A branch that is always drawn in its own reserved column (#207). */
export interface PinnedBranch {
	readonly hash: Hash;
	readonly name: string;
}

export const FileChangeType = {
	Added: 'A',
	Modified: 'M',
	Deleted: 'D',
	Renamed: 'R',
	Untracked: 'U'
} as const;
export type FileChangeType = (typeof FileChangeType)[keyof typeof FileChangeType];

export interface FileChange {
	readonly type: FileChangeType;
	/** Repo-relative path, forward slashes. */
	readonly path: string;
	/** Previous path for renames, otherwise null. */
	readonly oldPath: string | null;
	readonly additions: number | null;
	readonly deletions: number | null;
}

export interface CommitDetails {
	readonly hash: Hash;
	readonly parents: readonly Hash[];
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly committer: string;
	readonly committerEmail: string;
	readonly committerDate: number;
	readonly subject: string;
	readonly body: string;
	readonly signature: CommitSignature | null;
	readonly fileChanges: readonly FileChange[];
}

export const SignatureStatus = {
	Good: 'G',
	BadSignature: 'B',
	GoodUnknownValidity: 'U',
	GoodExpired: 'X',
	GoodExpiredKey: 'Y',
	GoodRevokedKey: 'R',
	CannotBeChecked: 'E',
	NoSignature: 'N'
} as const;
export type SignatureStatus = (typeof SignatureStatus)[keyof typeof SignatureStatus];

export interface CommitSignature {
	readonly status: SignatureStatus;
	readonly key: string;
	readonly signer: string;
}

/**
 * What to compare: `hash` against `base`. `hash` may be `UNCOMMITTED`, meaning
 * the working tree; `base` is null for a root commit, which is compared with
 * the empty tree.
 */
export interface ChangeTarget {
	readonly repo: string;
	readonly hash: Hash;
	readonly base: Hash | null;
}

/** A filter applied to `git log`, mirroring the filter bar in the view. */
export interface LogFilter {
	/** Restrict history to commits touching these repo-relative paths (#70). */
	readonly paths: readonly string[];
	/** `--author=` patterns (#171). */
	readonly authors: readonly string[];
	/** Branches to include; empty means the current HEAD or all refs. */
	readonly branches: readonly string[];
	/** `--exclude=` glob patterns (#360). */
	readonly excludeGlobs: readonly string[];
	readonly showRemoteBranches: boolean;
	readonly showTags: boolean;
	/** Free text matched against the commit message, `--grep=`. */
	readonly grep: string | null;
	readonly since: string | null;
	readonly until: string | null;
	/** Extra arguments appended verbatim to `git log` (#591). */
	readonly extraArgs: readonly string[];
}

export function emptyFilter(): LogFilter {
	return {
		paths: [],
		authors: [],
		branches: [],
		excludeGlobs: [],
		showRemoteBranches: true,
		showTags: true,
		grep: null,
		since: null,
		until: null,
		extraArgs: []
	};
}

export interface RepoState {
	readonly path: string;
	readonly name: string;
	/** Short name of the checked out branch, or null when detached. */
	readonly head: string | null;
	readonly headHash: Hash | null;
	readonly isDetached: boolean;
	/** Set while a merge, rebase, cherry-pick or revert is in progress. */
	readonly pendingOperation: PendingOperation | null;
}

/**
 * Everything the view needs to draw one repository's graph, in one message.
 *
 * Layout is deliberately absent: it is a pure function of `commits`, so the
 * webview computes it and can redo it without a round trip to the host.
 */
export interface GraphData {
	readonly repo: RepoState;
	/**
	 * Rows in display order. May start with the synthetic Uncommitted Changes
	 * row (hash `UNCOMMITTED`) and contains stash rows, identified by `stash`.
	 */
	readonly commits: readonly Commit[];
	readonly heads: readonly HeadRef[];
	readonly remoteHeads: readonly RemoteHeadRef[];
	readonly tags: readonly TagRef[];
	/** Remote name to the branch its HEAD points at, e.g. `origin` → `origin/main`. */
	readonly remoteHeadSymrefs: Readonly<Record<string, string>>;
	/** True when `git log` had more commits than were requested. */
	readonly moreAvailable: boolean;
	/** Remote names, for the push / fetch / delete-on-remote choices. */
	readonly remotes: readonly string[];
	/** Issue-link rules for this repository (#313), `$n` still to be filled per match. */
	readonly issueLinks: readonly { readonly pattern: string; readonly url: string }[];
	/** Loaded commits that have a git note (#475). */
	readonly notedCommits: readonly Hash[];
	/** Full names of refs hidden by exclude patterns (#360); their labels are not drawn. */
	readonly excludedRefs: readonly string[];
	/** The `maxCommits` this data was loaded with, echoed for Load More. */
	readonly maxCommits: number;
}

export const PendingOperation = {
	Merge: 'merge',
	Rebase: 'rebase',
	CherryPick: 'cherry-pick',
	Revert: 'revert',
	Bisect: 'bisect'
} as const;
export type PendingOperation = (typeof PendingOperation)[keyof typeof PendingOperation];

/**
 * A write action on a repository (Phase 3). Built by the view, validated and
 * run by the host; `planAction` turns each into exact git argument lists.
 * Names of existing refs are short names (`main`, `origin/main`, `v1.0`).
 */
export type GitAction =
	| { readonly kind: 'checkout'; readonly branch: string }
	| { readonly kind: 'checkoutDetached'; readonly hash: Hash }
	/** Creates a local branch tracking a remote branch, and checks it out. */
	| { readonly kind: 'checkoutRemote'; readonly remoteBranch: string; readonly localName: string }
	| { readonly kind: 'createBranch'; readonly name: string; readonly startPoint: Hash; readonly checkout: boolean; readonly force: boolean }
	| { readonly kind: 'deleteBranch'; readonly name: string; readonly force: boolean; readonly deleteOnRemote: string | null }
	| { readonly kind: 'renameBranch'; readonly from: string; readonly to: string }
	| { readonly kind: 'deleteRemoteBranch'; readonly remote: string; readonly branch: string }
	| { readonly kind: 'createTag'; readonly name: string; readonly target: Hash; readonly message: string | null; readonly force: boolean; readonly pushTo: string | null }
	| { readonly kind: 'deleteTag'; readonly name: string; readonly deleteOnRemote: string | null }
	| { readonly kind: 'pushTag'; readonly name: string; readonly remote: string }
	| { readonly kind: 'fetch'; readonly remote: string | null; readonly prune: boolean; readonly pruneTags: boolean }
	| { readonly kind: 'pull'; readonly mode: 'merge' | 'rebase' | 'ff-only' }
	| {
			readonly kind: 'push';
			readonly branch: string;
			readonly remote: string;
			readonly setUpstream: boolean;
			readonly force: 'none' | 'with-lease' | 'force';
	  }
	| { readonly kind: 'merge'; readonly ref: string; readonly noFastForward: boolean; readonly squash: boolean; readonly noCommit: boolean }
	| { readonly kind: 'rebase'; readonly onto: string }
	| { readonly kind: 'cherryPick'; readonly hash: Hash; readonly mainline: number | null; readonly noCommit: boolean; readonly recordOrigin: boolean }
	| { readonly kind: 'revert'; readonly hash: Hash; readonly mainline: number | null }
	| { readonly kind: 'reset'; readonly hash: Hash; readonly mode: 'soft' | 'mixed' | 'hard' }
	| { readonly kind: 'stashPush'; readonly message: string; readonly includeUntracked: boolean }
	| { readonly kind: 'stashApply'; readonly selector: string; readonly reinstateIndex: boolean }
	| { readonly kind: 'stashPop'; readonly selector: string; readonly reinstateIndex: boolean }
	| { readonly kind: 'stashDrop'; readonly selector: string }
	| { readonly kind: 'stashBranch'; readonly selector: string; readonly name: string }
	/** Discards uncommitted changes to tracked files (`reset --hard HEAD`). */
	| { readonly kind: 'discardChanges' }
	| { readonly kind: 'cleanUntracked'; readonly directories: boolean }
	| { readonly kind: 'continueOperation'; readonly operation: PendingOperation }
	| { readonly kind: 'abortOperation'; readonly operation: PendingOperation };
