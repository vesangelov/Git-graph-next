import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { GitExecutor } from '../git/executor.ts';
import { loadGraphData, readNote } from '../git/graphData.ts';
import { searchHistory } from '../git/search.ts';
import { parseQuery } from '../search/query.ts';
import type { RepoManager } from '../repoManager.ts';
import { graphDataRequest, openToActiveEditorRepo, viewConfig } from '../config.ts';
import type { ChangesService } from './changesView.ts';
import type { ActionRunner } from './actions.ts';
import { openChangeDiff, openWorkingFile } from './diff.ts';
import type { FilterState, HostMessage, LoadOptions, ViewMode, WebviewMessage } from './protocol.ts';

/**
 * A single file is followed across renames (#70). Folders cannot be: git's
 * `--follow` accepts exactly one file. A path that no longer exists was a file
 * that got deleted, so it is followed too.
 */
function followsRenames(options: LoadOptions): boolean {
	if (options.filter.paths?.length !== 1) return false;
	try {
		return !statSync(join(options.repo, options.filter.paths[0])).isDirectory();
	} catch {
		return true;
	}
}

/** Quiet period after the last file change before the graph reloads. */
const REFRESH_DEBOUNCE_MS = 750;

/** Services every graph view needs. */
export interface GraphServices {
	readonly extensionUri: vscode.Uri;
	readonly git: GitExecutor;
	readonly repos: RepoManager;
	readonly changes: ChangesService;
	readonly actions: ActionRunner;
}

/** The container a graph webview lives in: an editor panel or a sidebar view. */
export interface GraphHost {
	readonly webview: vscode.Webview;
	readonly visible: boolean;
	readonly onDidChangeVisibility: vscode.Event<unknown>;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
	return {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(extensionUri, 'media')]
	};
}

/**
 * Drives one graph webview: answers its messages, loads graph data, and
 * reloads it when the repository changes on disk. The same controller serves
 * the editor panel and the Activity Bar view; only `mode` differs.
 */
export class GraphController implements vscode.Disposable {
	private static readonly all = new Set<GraphController>();

	private readonly disposables: vscode.Disposable[] = [];
	private watcher: vscode.Disposable | undefined;
	private watchedRepo: string | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** A change arrived while hidden; reload when shown again. */
	private stale = false;
	/** The options of the load currently on screen, reused to refresh it. */
	private lastLoad: LoadOptions | null = null;
	/** Increments per load, so a slow response cannot overwrite a newer one. */
	private loadGeneration = 0;
	private ready = false;
	/** Repository to switch to once the webview reports it is ready. */
	private pendingRepo: string | null;
	/** Filter to apply once the webview reports it is ready. */
	private pendingFilter: { repo: string; filter: Partial<FilterState> } | null = null;

	/** Reloads every open graph view. */
	static refreshAll(): void {
		for (const controller of GraphController.all) controller.reload();
	}

	constructor(
		private readonly host: GraphHost,
		private readonly services: GraphServices,
		private readonly mode: ViewMode,
		initialRepo: string | null = null
	) {
		GraphController.all.add(this);
		this.pendingRepo = initialRepo;
		host.webview.html = this.html();

		this.disposables.push(
			host.webview.onDidReceiveMessage((message: WebviewMessage) => void this.receive(message)),
			host.onDidChangeVisibility(() => {
				if (host.visible && this.stale) this.reload();
			}),
			services.repos.onDidChange(() => this.postRepos(null)),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration('git-graph-next')) return;
				this.post({ type: 'config', config: viewConfig() });
				this.reload();
			})
		);
	}

	dispose(): void {
		GraphController.all.delete(this);
		clearTimeout(this.refreshTimer);
		this.watcher?.dispose();
		for (const disposable of this.disposables.splice(0)) disposable.dispose();
	}

	selectRepo(repo: string): void {
		if (this.ready) this.postRepos(repo);
		else this.pendingRepo = repo;
	}

	/** Shows `repo` with parts of its filter replaced, e.g. a path for "View File History". */
	applyFilter(repo: string, filter: Partial<FilterState>): void {
		if (this.ready) {
			this.postRepos(repo);
			this.post({ type: 'setFilter', repo, filter });
		} else {
			this.pendingRepo = repo;
			this.pendingFilter = { repo, filter };
		}
	}

	/** Switches the view's compact mode (#387). */
	toggleCompact(): void {
		this.post({ type: 'toggleCompact' });
	}

	/** Opens the view's Fetch dialog. */
	openFetch(): void {
		this.post({ type: 'runFetch' });
	}

	reload(): void {
		if (this.lastLoad === null) return;
		if (!this.host.visible) {
			this.stale = true;
			return;
		}
		void this.load(this.lastLoad);
	}

	private post(message: HostMessage): void {
		void this.host.webview.postMessage(message);
	}

	/**
	 * Sends the repository list. The selection is, in priority order: an
	 * explicit request, the repository the view already shows, the active
	 * editor's repository when configured, then the first one.
	 */
	private postRepos(requested: string | null): void {
		const list = this.services.repos.repositories;
		const has = (path: string | null | undefined): path is string => path != null && list.some((r) => r.path === path);

		let selected: string | null = null;
		if (has(requested)) selected = requested;
		else if (has(this.lastLoad?.repo)) selected = this.lastLoad!.repo;
		else {
			const editor = vscode.window.activeTextEditor?.document.uri;
			const editorRepo = openToActiveEditorRepo() && editor?.scheme === 'file' ? this.services.repos.repositoryFor(editor.fsPath) : null;
			selected = editorRepo?.path ?? list[0]?.path ?? null;
		}

		this.post({ type: 'repos', repos: list.map((r) => ({ path: r.path, name: r.name })), selected });
		if (selected === null) {
			this.lastLoad = null;
			this.watch(null);
		}
	}

	private async receive(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this.ready = true;
				this.post({ type: 'config', config: viewConfig() });
				// A repository requested by a command beats the one the webview remembers.
				this.postRepos(this.pendingRepo ?? message.repo);
				if (this.pendingFilter !== null) this.post({ type: 'setFilter', ...this.pendingFilter });
				this.pendingRepo = null;
				this.pendingFilter = null;
				break;
			case 'load':
				await this.load(message.options);
				break;
			case 'copyToClipboard':
				await vscode.env.clipboard.writeText(message.text);
				vscode.window.setStatusBarMessage(`Copied ${message.label} to the clipboard`, 3000);
				break;
			case 'selectCommit': {
				const { target } = message;
				const note = message.hasNote ? readNote(this.services.git, target.repo, target.hash) : Promise.resolve(null);
				try {
					const changes = await this.services.changes.select(target, message.title);
					this.post({ type: 'changes', repo: target.repo, hash: target.hash, changes, error: null, note: await note });
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					this.post({ type: 'changes', repo: target.repo, hash: target.hash, changes: null, error: text, note: await note });
				}
				break;
			}
			case 'searchHistory': {
				const { requestId, options } = message;
				const query = parseQuery(message.query);
				if (query === null) {
					this.post({ type: 'searchResult', requestId, match: null, error: null });
					break;
				}
				try {
					const request = graphDataRequest(options, followsRenames(options));
					const useCommitDate = viewConfig().dateType === 'Commit Date';
					const match = await searchHistory(this.services.git, options.repo, request, query, message.fromPosition, useCommitDate);
					this.post({ type: 'searchResult', requestId, match, error: null });
				} catch (error) {
					this.post({ type: 'searchResult', requestId, match: null, error: error instanceof Error ? error.message : String(error) });
				}
				break;
			}
			case 'query': {
				const known = this.services.repos.repositories.some((r) => r.path === message.repo);
				const output = known ? await this.services.git.runOrNull(message.repo, ['branch', '--merged', 'HEAD', '--format=%(refname:short)']) : null;
				const value = output === null ? null : output.split('\n').map((l) => l.trim()).filter((l) => l !== '');
				this.post({ type: 'queryResult', requestId: message.requestId, value });
				break;
			}
			case 'runAction': {
				const known = this.services.repos.repositories.some((r) => r.path === message.repo);
				const error = known ? await this.services.actions.run(message.repo, message.action) : `${message.repo} is not a known repository.`;
				this.post({ type: 'actionResult', requestId: message.requestId, error });
				break;
			}
			case 'openUrl': {
				// The webview only makes http(s) links, but it is not trusted to.
				const uri = vscode.Uri.parse(message.url, true);
				if (uri.scheme === 'http' || uri.scheme === 'https') await vscode.env.openExternal(uri);
				break;
			}
			case 'openDiff':
				await openChangeDiff(message.target, message.change);
				break;
			case 'openFile':
				await openWorkingFile(message.repo, message.path);
				break;
		}
	}

	private async load(options: LoadOptions): Promise<void> {
		if (!this.services.repos.repositories.some((r) => r.path === options.repo)) {
			this.post({ type: 'error', repo: options.repo, message: `${options.repo} is no longer a known repository.` });
			return;
		}
		const generation = ++this.loadGeneration;
		this.lastLoad = options;
		this.stale = false;
		this.watch(options.repo);
		this.post({ type: 'loading', repo: options.repo });

		try {
			const data = await loadGraphData(this.services.git, options.repo, graphDataRequest(options, followsRenames(options)));
			if (generation === this.loadGeneration) this.post({ type: 'graph', data });
		} catch (error) {
			if (generation !== this.loadGeneration) return;
			this.post({ type: 'error', repo: options.repo, message: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Reloads the graph when the repository changes on disk: a commit, a
	 * checkout, a fetch, or an edit to a tracked file. Object writes and lock
	 * files are ignored; they accompany the ref or index change that matters and
	 * would otherwise trigger a reload per object.
	 */
	private watch(repo: string | null): void {
		if (repo === this.watchedRepo) return;
		this.watcher?.dispose();
		this.watcher = undefined;
		this.watchedRepo = repo;
		if (repo === null) return;

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(repo), '**'));
		const onChange = (uri: vscode.Uri) => {
			const path = uri.path;
			if (path.includes('/.git/objects/') || path.endsWith('.lock') || path.includes('/.git/logs/')) return;
			clearTimeout(this.refreshTimer);
			this.refreshTimer = setTimeout(() => this.reload(), REFRESH_DEBOUNCE_MS);
		};
		this.watcher = vscode.Disposable.from(watcher, watcher.onDidChange(onChange), watcher.onDidCreate(onChange), watcher.onDidDelete(onChange));
	}

	private html(): string {
		const webview = this.host.webview;
		const nonce = randomBytes(16).toString('base64');
		const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.services.extensionUri, 'dist', 'webview', file));
		// No 'unsafe-inline' anywhere: styles come from the stylesheet and are
		// adjusted only through the CSSOM, which CSP does not restrict.
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource}`,
			`img-src ${webview.cspSource} data:`,
			`font-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${asset('style.css')}">
	<title>Git Graph</title>
</head>
<body data-mode="${this.mode}">
	<div id="app"></div>
	<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
	}
}
