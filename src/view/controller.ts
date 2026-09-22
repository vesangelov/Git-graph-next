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
import { compareWithWorkingFile, openAllChanges, openChangeDiff, openFileAtRevision, openWorkingFile } from './diff.ts';
import type { ReviewManager } from './review.ts';
import type { AvatarService } from './avatars.ts';
import type { FilterState, HostMessage, LoadOptions, ViewMode, WebviewMessage } from './protocol.ts';
import { HASH, isSafeRefName, isValidTarget } from './validation.ts';
import { UNCOMMITTED, type ChangeTarget } from '../types.ts';

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
	readonly reviews: ReviewManager;
	/** "Git Graph Next" in the Output panel: the git commands actions ran (#848). */
	readonly output: vscode.OutputChannel;
	readonly avatars: AvatarService;
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
			services.reviews.onDidChange(() => this.post({ type: 'reviewState', review: services.reviews.summary() })),
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
		const known = this.services.repos.repositories.map((r) => r.path);
		const target = 'target' in message ? message.target : undefined;
		if (target !== undefined && !isValidTarget(target, known)) return;
		switch (message.type) {
			case 'ready':
				this.ready = true;
				this.post({ type: 'config', config: viewConfig() });
				// A repository requested by a command beats the one the webview remembers.
				this.postRepos(this.pendingRepo ?? message.repo);
				if (this.pendingFilter !== null) this.post({ type: 'setFilter', ...this.pendingFilter });
				this.post({ type: 'reviewState', review: this.services.reviews.summary() });
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
				let value: string[] | null = null;
				if (known.includes(message.repo) && message.query === 'mergedBranches') {
					const output = await this.services.git.runOrNull(message.repo, ['branch', '--merged', 'HEAD', '--format=%(refname:short)']);
					value = output === null ? null : output.split('\n').map((l) => l.trim()).filter((l) => l !== '');
				} else if (known.includes(message.repo) && message.query === 'userConfig') {
					// The repository's own values only: empty means the global one applies.
					const read = async (key: string) => ((await this.services.git.runOrNull(message.repo, ['config', '--local', '--get', key])) ?? '').trim();
					value = [await read('user.name'), await read('user.email')];
				}
				this.post({ type: 'queryResult', requestId: message.requestId, value });
				break;
			}
			case 'runAction': {
				const known = this.services.repos.repositories.some((r) => r.path === message.repo);
				const error = known ? await this.services.actions.run(message.repo, message.action) : `${message.repo} is not a known repository.`;
				this.post({ type: 'actionResult', requestId: message.requestId, error });
				break;
			}
			case 'externalDiff':
				void this.openExternalDiff(message.target);
				break;
			case 'avatars':
				if (viewConfig().avatars && Array.isArray(message.emails)) {
					const emails = message.emails.filter((e): e is string => typeof e === 'string').slice(0, 200);
					this.post({ type: 'avatars', avatars: await this.services.avatars.get(emails) });
				}
				break;
			case 'showOutput':
				this.services.output.show(true);
				break;
			case 'openUrl': {
				// The webview only makes http(s) links, but it is not trusted to.
				const uri = vscode.Uri.parse(message.url, true);
				if (uri.scheme === 'http' || uri.scheme === 'https') await vscode.env.openExternal(uri);
				break;
			}
			case 'openDiff':
				await openChangeDiff(message.target, message.change);
				await this.services.reviews.markOpened(message.target, message.change.path);
				break;
			case 'openAllChanges': {
				const changes = await this.services.changes.load(message.target);
				await openAllChanges(message.target, changes, message.title);
				break;
			}
			case 'openRevisionFile':
				if (!known.includes(message.repo) || !HASH.test(message.hash)) return;
				if (message.compare) await compareWithWorkingFile(message.repo, message.hash, message.path);
				else await openFileAtRevision(message.repo, message.hash, message.path);
				break;
			case 'review': {
				const reviews = this.services.reviews;
				let error: string | null = null;
				if (message.command === 'start') error = await reviews.start(message.target, message.title);
				else if (message.command === 'startBranch') {
					if (!known.includes(message.repo) || !isSafeRefName(message.branch) || !isSafeRefName(message.against)) return;
					error = await reviews.startBranch(message.repo, message.branch, message.against);
				}
				else if (message.command === 'next') await reviews.next();
				else if (message.command === 'previous') await reviews.previous();
				else if (message.command === 'end') await reviews.end();
				else if (message.command === 'openAll') await reviews.openAll();
				else if (message.command === 'toggle') await reviews.toggle(message.path);
				if (error !== null) void vscode.window.showWarningMessage(error);
				break;
			}
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
	 * `git difftool --dir-diff` on a commit or comparison (the original's
	 * "Open External Directory Diff"). Only with a graphical tool: a terminal
	 * one such as vimdiff would open where nobody can see it and never return.
	 * Not awaited or queued — the tool stays open as long as the user likes.
	 */
	private async openExternalDiff(target: ChangeTarget): Promise<void> {
		const git = this.services.git;
		const config = async (key: string) => ((await git.runOrNull(target.repo, ['config', '--get', key])) ?? '').trim();
		const [guiTool, tool] = await Promise.all([config('diff.guitool'), config('diff.tool')]);
		const terminalTools = ['vimdiff', 'vimdiff1', 'vimdiff2', 'vimdiff3', 'nvimdiff', 'emerge'];
		if (guiTool === '' && (tool === '' || terminalTools.includes(tool))) {
			void vscode.window.showWarningMessage(
				'Open External Directory Diff needs a graphical diff tool. Set one with, for example: git config --global diff.guitool meld'
			);
			return;
		}
		// A root commit is compared with the empty tree, in this repository's hash format.
		const base = target.base ?? (await git.run(target.repo, ['mktree'], { stdin: '' })).trim();
		const range = target.hash === UNCOMMITTED ? [base] : [base, target.hash];
		const args = ['difftool', '--dir-diff', '--no-prompt', ...(guiTool !== '' ? ['--gui'] : []), ...range];
		this.services.output.appendLine(`[${new Date().toLocaleTimeString()}] git ${args.join(' ')}`);
		try {
			await git.run(target.repo, args);
		} catch (error) {
			void vscode.window.showErrorMessage(`The external diff failed: ${error instanceof Error ? error.message : String(error)}`);
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
