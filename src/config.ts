import * as vscode from 'vscode';
import { completeFilter, type LoadOptions, type ViewConfig } from './view/protocol.ts';
import type { GraphDataRequest } from './git/graphData.ts';
import { emptyFilter } from './types.ts';
import { validateArgs } from './git/extraArgs.ts';

export const SECTION = 'git-graph-next';

const DEFAULT_COLOURS = [
	'#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000',
	'#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'
];

function section(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(SECTION);
}

/** Reads a setting, falling back when the stored value has the wrong type. */
function read<T>(key: string, fallback: T, valid: (value: unknown) => boolean = (v) => typeof v === typeof fallback): T {
	const value = section().get<unknown>(key);
	return value !== undefined && value !== null && valid(value) ? (value as T) : fallback;
}

function oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	return read<T>(key, fallback, (v) => typeof v === 'string' && (allowed as readonly string[]).includes(v));
}

/**
 * Candidate git binaries, most specific first: this extension's own setting,
 * then the built-in Git extension's `git.path`, then whatever is on PATH.
 */
export function gitPathCandidates(): string[] {
	const toList = (value: unknown): string[] => {
		if (typeof value === 'string') return value.trim() === '' ? [] : [value];
		if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
		return [];
	};
	return [
		...toList(section().get('git.path')),
		...toList(vscode.workspace.getConfiguration('git').get('path')),
		'git'
	];
}

export function viewConfig(): ViewConfig {
	const colours = read<string[]>('graph.colours', DEFAULT_COLOURS, (v) => Array.isArray(v) && v.length > 0 && v.every((c) => typeof c === 'string'));
	return {
		colours,
		graphStyle: oneOf('graph.style', ['rounded', 'angular'], 'rounded'),
		dateType: oneOf('date.type', ['Author Date', 'Commit Date'], 'Author Date'),
		dateFormat: oneOf('date.format', ['Date & Time', 'Date Only', 'ISO Date & Time', 'ISO Date Only', 'Relative'], 'Date & Time'),
		stickyHeader: read('graph.stickyHeader', true),
		combineLocalAndRemoteBranchLabels: read('referenceLabels.combineLocalAndRemoteBranchLabels', true),
		showRemoteHeads: read('repository.showRemoteHeads', true),
		maxCommits: initialMaxCommits(),
		loadMoreCommits: Math.max(1, Math.floor(read('loadMoreCommits', 100))),
		loadMoreCommitsAutomatically: read('loadMoreCommitsAutomatically', true),
		showRemoteBranches: read('showRemoteBranches', true),
		showTags: read('showTags', true),
		pinnedBranches: stringList('graph.pinnedBranches')
	};
}

export function initialMaxCommits(): number {
	return Math.max(1, Math.floor(read('maxCommits', 300)));
}

export function maxDepthOfRepoSearch(): number {
	return Math.max(0, Math.floor(read('maxDepthOfRepoSearch', 0)));
}

export function retainContextWhenHidden(): boolean {
	return read('retainContextWhenHidden', true);
}

export function showStatusBarItem(): boolean {
	return read('showStatusBarItem', true);
}

export function showUntrackedFiles(): boolean {
	return read('showUntrackedFiles', true);
}

export function openToActiveEditorRepo(): boolean {
	return read('openToTheRepoOfTheActiveTextEditorDocument', false);
}

/** A setting holding a list of strings; anything else in it is ignored. */
function stringList(key: string): string[] {
	const value = section().get<unknown>(key);
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

/**
 * Builds the loader request for the options the webview asked for. Throws
 * when an extra `git log` argument is not allowed, naming it and why.
 */
export function graphDataRequest(options: LoadOptions, followRenames: boolean): GraphDataRequest {
	const ordering = oneOf('commitOrdering', ['date', 'author-date', 'topological'], 'date');
	// Complete the filter: a panel restored from an older version may send fewer fields.
	const filter = completeFilter(options.filter);
	const extraArgs = [...stringList('extraLogArguments'), ...filter.logArgs];
	const invalid = validateArgs(extraArgs);
	if (invalid !== null) throw new Error(invalid);
	return {
		filter: {
			...emptyFilter(),
			showRemoteBranches: options.showRemoteBranches,
			showTags: options.showTags,
			branches: filter.branches,
			authors: filter.authors,
			paths: filter.paths,
			excludeGlobs: [...stringList('excludeBranches'), ...filter.excludes],
			extraArgs
		},
		followRenames,
		maxCommits: Math.max(1, Math.floor(options.maxCommits)),
		ordering,
		onlyFollowFirstParent: read('onlyFollowFirstParent', false),
		includeCommitsMentionedByReflogs: read('includeCommitsMentionedByReflogs', false),
		showUncommittedChanges: read('showUncommittedChanges', true),
		showUntrackedFiles: read('showUntrackedFiles', true)
	};
}
