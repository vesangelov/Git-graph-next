/**
 * Messages exchanged between the extension host and the graph webview.
 *
 * Both directions are discriminated unions on `type`, so a switch over a
 * message narrows its payload and an unhandled message type is a compile
 * error rather than a silently ignored postMessage. Imported by both bundles;
 * it must stay free of `vscode` and Node imports.
 */
import type { ChangeTarget, FileChange, GitAction, GraphData, Hash } from '../types.ts';

/** The active code review, as the views draw it (see src/view/review.ts). */
export interface ReviewSummary {
	readonly repo: string;
	readonly hash: Hash;
	readonly base: Hash | null;
	readonly title: string;
	readonly total: number;
	readonly reviewed: readonly string[];
	readonly current: string | null;
}

/** Where the webview is shown: the editor-area panel, or the Activity Bar sidebar. */
export type ViewMode = 'panel' | 'sidebar';

/** Settings the webview needs to render, resolved on the host from configuration. */
export interface ViewConfig {
	readonly colours: readonly string[];
	readonly graphStyle: 'rounded' | 'angular';
	readonly dateType: 'Author Date' | 'Commit Date';
	readonly dateFormat: 'Date & Time' | 'Date Only' | 'ISO Date & Time' | 'ISO Date Only' | 'Relative';
	readonly stickyHeader: boolean;
	readonly combineLocalAndRemoteBranchLabels: boolean;
	readonly showRemoteHeads: boolean;
	/** Commits requested on first load of a repository. */
	readonly maxCommits: number;
	readonly loadMoreCommits: number;
	readonly loadMoreCommitsAutomatically: boolean;
	readonly showRemoteBranches: boolean;
	readonly showTags: boolean;
	/** Branch name patterns drawn in a column of their own, in priority order (#207). */
	readonly pinnedBranches: readonly string[];
	/** Fixed colours for branches, as [pattern, CSS colour] in priority order (#254). */
	readonly branchColours: readonly (readonly [string, string])[];
	/** Tint each commit row with its branch colour (#254). */
	readonly colourRows: boolean;
	/** Draw tag labels at the right-hand end of the description. */
	readonly tagsOnRight: boolean;
	/** Show author avatars (opt-in: fetching them contacts Gravatar / GitHub). */
	readonly avatars: boolean;
	/** Defaults for the Fetch dialog. */
	readonly fetchAndPrune: boolean;
	readonly fetchAndPruneTags: boolean;
}

export interface RepoOption {
	readonly path: string;
	readonly name: string;
}

/** Host → webview. */
export type HostMessage =
	| { readonly type: 'config'; readonly config: ViewConfig }
	| {
			readonly type: 'repos';
			readonly repos: readonly RepoOption[];
			/** The repository the view should show, or null when there are none. */
			readonly selected: string | null;
	  }
	| { readonly type: 'loading'; readonly repo: string }
	| { readonly type: 'graph'; readonly data: GraphData }
	/** Switches compact mode (#387), from the sidebar's title bar. */
	| { readonly type: 'toggleCompact' }
	/** Opens the Fetch dialog, from the sidebar's title bar. */
	| { readonly type: 'runFetch' }
	/** Replaces parts of a repository's filter, e.g. from "View File History". Switches to that repository. */
	| { readonly type: 'setFilter'; readonly repo: string; readonly filter: Partial<FilterState> }
	| { readonly type: 'error'; readonly repo: string | null; readonly message: string }
	| {
			readonly type: 'searchResult';
			readonly requestId: number;
			/** The match and its index among log commits, or null when history holds no further match. */
			readonly match: { readonly hash: Hash; readonly position: number } | null;
			readonly error: string | null;
	  }
	/** Avatars by lower-case e-mail; null for an author who has none. */
	| { readonly type: 'avatars'; readonly avatars: Readonly<Record<string, string | null>> }
	/** The active code review, or null; sent whenever it changes. */
	| { readonly type: 'reviewState'; readonly review: ReviewSummary | null }
	/** The answer to a `query`; null when git could not answer. */
	| { readonly type: 'queryResult'; readonly requestId: number; readonly value: readonly string[] | null }
	/** The outcome of a `runAction`: null on success, else the message to show. */
	| { readonly type: 'actionResult'; readonly requestId: number; readonly error: string | null }
	| {
			readonly type: 'changes';
			readonly repo: string;
			readonly hash: Hash;
			readonly changes: readonly FileChange[] | null;
			readonly error: string | null;
			/** The commit's git note (#475), when it has one. */
			readonly note: string | null;
	  };

/** The filters chosen in the view's filter bar, kept per repository. */
export interface FilterState {
	/** Full ref names (`refs/heads/main`, `refs/remotes/origin/main`); empty shows all (#760). */
	readonly branches: readonly string[];
	/** Author names or e-mail fragments, matched literally and case-insensitively (#171). */
	readonly authors: readonly string[];
	/** Repo-relative files or folders, forward slashes (#70). */
	readonly paths: readonly string[];
	/** `--exclude` glob patterns hiding branches and tags, on top of the setting (#360). */
	readonly excludes: readonly string[];
	/** Extra `git log` arguments, on top of the setting (#591). */
	readonly logArgs: readonly string[];
}

export const NO_FILTER: FilterState = { branches: [], authors: [], paths: [], excludes: [], logArgs: [] };

/** Fills fields missing from a filter saved by an older version. */
export function completeFilter(filter: Partial<FilterState> | undefined): FilterState {
	return { ...NO_FILTER, ...filter };
}

export function isFiltered(filter: FilterState): boolean {
	return (
		filter.branches.length > 0 || filter.authors.length > 0 || filter.paths.length > 0 ||
		filter.excludes.length > 0 || filter.logArgs.length > 0
	);
}

/** What the webview asks the graph to be loaded with. */
export interface LoadOptions {
	readonly repo: string;
	readonly maxCommits: number;
	readonly showRemoteBranches: boolean;
	readonly showTags: boolean;
	readonly filter: FilterState;
}

/** Webview → host. */
export type WebviewMessage =
	/** Sent once the webview script is running and can receive messages. */
	| { readonly type: 'ready'; readonly repo: string | null }
	| { readonly type: 'load'; readonly options: LoadOptions }
	| { readonly type: 'copyToClipboard'; readonly text: string; readonly label: string }
	/** The user selected a row; the host loads its changed files. */
	| { readonly type: 'selectCommit'; readonly target: ChangeTarget; readonly title: string; readonly hasNote: boolean }
	| { readonly type: 'openDiff'; readonly target: ChangeTarget; readonly change: FileChange }
	/**
	 * Searches history beyond the loaded commits for the first match at or
	 * after `fromPosition` (an index among log commits), with the same
	 * options the graph was loaded with.
	 */
	| { readonly type: 'searchHistory'; readonly requestId: number; readonly options: LoadOptions; readonly query: string; readonly fromPosition: number }
	/** Code review mode: start one for a commit or comparison, or step through the active one. */
	| { readonly type: 'review'; readonly command: 'start'; readonly target: ChangeTarget; readonly title: string }
	| { readonly type: 'review'; readonly command: 'startBranch'; readonly repo: string; readonly branch: string; readonly against: string }
	| { readonly type: 'review'; readonly command: 'next' | 'previous' | 'end' | 'openAll' }
	| { readonly type: 'review'; readonly command: 'toggle'; readonly path: string }
	/** Opens all of a commit's or comparison's changed files in one editor (#807). */
	| { readonly type: 'openAllChanges'; readonly target: ChangeTarget; readonly title: string }
	/** Opens a file as it was at a commit, or compares it with the working tree. */
	| { readonly type: 'openRevisionFile'; readonly repo: string; readonly hash: Hash; readonly path: string; readonly compare: boolean }
	/** Asks the host for information a dialog needs, e.g. which branches are merged (#184). */
	| { readonly type: 'query'; readonly requestId: number; readonly repo: string; readonly query: 'mergedBranches' | 'userConfig' }
	/** `git difftool --dir-diff` for a commit or comparison, as the original offered. */
	| { readonly type: 'externalDiff'; readonly target: ChangeTarget }
	/** Asks for the avatars of these authors (only when avatars are enabled). */
	| { readonly type: 'avatars'; readonly emails: readonly string[] }
	/** Shows the log of git commands the actions ran (#848). */
	| { readonly type: 'showOutput' }
	/** Runs a write action (Phase 3). The host validates it again before running anything. */
	| { readonly type: 'runAction'; readonly requestId: number; readonly repo: string; readonly action: GitAction }
	/** Opens an issue link (#313) in the browser. The host accepts http(s) only. */
	| { readonly type: 'openUrl'; readonly url: string }
	/** Opens the working-tree version of a repo-relative path. */
	| { readonly type: 'openFile'; readonly repo: string; readonly path: string };

/** State the webview persists with `vscode.setState`, surviving hide/show and reloads. */
export interface PersistedViewState {
	readonly repo: string | null;
	readonly scrollTop: number;
	readonly showRemoteBranches: boolean | null;
	/** Height of the commit details pane, once the user has resized it. */
	readonly detailsHeight?: number | null;
	/** Filters per repository path. */
	readonly filters?: Readonly<Record<string, Partial<FilterState>>>;
	/** Branches pinned from the context menu, per repository path (#207). */
	readonly pins?: Readonly<Record<string, readonly string[]>>;
	/** Compact mode (#387). */
	readonly compact?: boolean;
}
