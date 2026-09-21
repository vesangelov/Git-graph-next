/**
 * Messages exchanged between the extension host and the graph webview.
 *
 * Both directions are discriminated unions on `type`, so a switch over a
 * message narrows its payload and an unhandled message type is a compile
 * error rather than a silently ignored postMessage. Imported by both bundles;
 * it must stay free of `vscode` and Node imports.
 */
import type { GraphData } from '../types.ts';

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
	| { readonly type: 'error'; readonly repo: string | null; readonly message: string };

/** What the webview asks the graph to be loaded with. */
export interface LoadOptions {
	readonly repo: string;
	readonly maxCommits: number;
	readonly showRemoteBranches: boolean;
	readonly showTags: boolean;
}

/** Webview → host. */
export type WebviewMessage =
	/** Sent once the webview script is running and can receive messages. */
	| { readonly type: 'ready'; readonly repo: string | null }
	| { readonly type: 'load'; readonly options: LoadOptions }
	| { readonly type: 'copyToClipboard'; readonly text: string; readonly label: string };

/** State the webview persists with `vscode.setState`, surviving hide/show and reloads. */
export interface PersistedViewState {
	readonly repo: string | null;
	readonly scrollTop: number;
	readonly showRemoteBranches: boolean | null;
}
