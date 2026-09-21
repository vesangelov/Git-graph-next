import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { GitExecutor } from '../git/executor.ts';
import { loadGraphData } from '../git/graphData.ts';
import type { RepoManager } from '../repoManager.ts';
import { graphDataRequest, openToActiveEditorRepo, retainContextWhenHidden, viewConfig } from '../config.ts';
import type { HostMessage, LoadOptions, WebviewMessage } from './protocol.ts';

export const VIEW_TYPE = 'gitGraphNext.view';

/** Quiet period after the last file change before the graph reloads. */
const REFRESH_DEBOUNCE_MS = 750;

/**
 * The Git Graph webview panel. At most one exists; opening the graph again
 * reveals it and, when a repository is named, switches to that repository.
 */
export class GraphPanel implements vscode.Disposable {
	private static current: GraphPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	private watcher: vscode.Disposable | undefined;
	private watchedRepo: string | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** A change arrived while hidden; reload when the panel is shown again. */
	private stale = false;
	/** The options of the load currently on screen, reused to refresh it. */
	private lastLoad: LoadOptions | null = null;
	/** Increments per load, so a slow response cannot overwrite a newer one. */
	private loadGeneration = 0;
	private ready = false;
	/** Repository to switch to once the webview reports it is ready. */
	private pendingRepo: string | null;

	/** Opens the graph, or reveals it, optionally switching repository. */
	static show(extensionUri: vscode.Uri, git: GitExecutor, repos: RepoManager, repo: string | null = null): void {
		if (GraphPanel.current !== undefined) {
			GraphPanel.current.panel.reveal();
			if (repo !== null) GraphPanel.current.selectRepo(repo);
			return;
		}
		const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Git Graph', vscode.ViewColumn.One, GraphPanel.options(extensionUri));
		GraphPanel.current = new GraphPanel(panel, extensionUri, git, repos, repo);
	}

	/** Re-attaches to a panel VS Code restored after a reload or restart. */
	static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, git: GitExecutor, repos: RepoManager): void {
		GraphPanel.current?.dispose();
		panel.webview.options = GraphPanel.options(extensionUri);
		GraphPanel.current = new GraphPanel(panel, extensionUri, git, repos, null);
	}

	/** Reloads the graph, if it is open. */
	static refresh(): void {
		GraphPanel.current?.reload();
	}

	static disposeCurrent(): void {
		GraphPanel.current?.dispose();
	}

	private static options(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
		return {
			enableScripts: true,
			retainContextWhenHidden: retainContextWhenHidden(),
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview'), vscode.Uri.joinPath(extensionUri, 'media')]
		};
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly extensionUri: vscode.Uri,
		private readonly git: GitExecutor,
		private readonly repos: RepoManager,
		initialRepo: string | null
	) {
		this.pendingRepo = initialRepo;
		panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
		panel.webview.html = this.html();

		this.disposables.push(
			panel.onDidDispose(() => this.dispose()),
			panel.webview.onDidReceiveMessage((message: WebviewMessage) => void this.receive(message)),
			panel.onDidChangeViewState(() => {
				if (panel.visible && this.stale) this.reload();
			}),
			repos.onDidChange(() => this.postRepos(null)),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration('git-graph-next')) return;
				this.post({ type: 'config', config: viewConfig() });
				this.reload();
			})
		);
	}

	dispose(): void {
		if (GraphPanel.current === this) GraphPanel.current = undefined;
		clearTimeout(this.refreshTimer);
		this.watcher?.dispose();
		for (const disposable of this.disposables.splice(0)) disposable.dispose();
		this.panel.dispose();
	}

	private selectRepo(repo: string): void {
		if (this.ready) this.postRepos(repo);
		else this.pendingRepo = repo;
	}

	private post(message: HostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	/**
	 * Sends the repository list. The selection is, in priority order: an
	 * explicit request, the repository the view already shows, the active
	 * editor's repository when configured, then the first one.
	 */
	private postRepos(requested: string | null): void {
		const list = this.repos.repositories;
		const has = (path: string | null | undefined): path is string => path != null && list.some((r) => r.path === path);

		let selected: string | null = null;
		if (has(requested)) selected = requested;
		else if (has(this.lastLoad?.repo)) selected = this.lastLoad!.repo;
		else {
			const editor = vscode.window.activeTextEditor?.document.uri;
			const editorRepo = openToActiveEditorRepo() && editor?.scheme === 'file' ? this.repos.repositoryFor(editor.fsPath) : null;
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
			case 'ready': {
				this.ready = true;
				this.post({ type: 'config', config: viewConfig() });
				// A repository requested by a command beats the one the webview remembers.
				this.postRepos(this.pendingRepo ?? message.repo);
				this.pendingRepo = null;
				break;
			}
			case 'load':
				await this.load(message.options);
				break;
			case 'copyToClipboard':
				await vscode.env.clipboard.writeText(message.text);
				vscode.window.setStatusBarMessage(`Copied ${message.label} to the clipboard`, 3000);
				break;
		}
	}

	private reload(): void {
		if (this.lastLoad === null) return;
		if (!this.panel.visible) {
			this.stale = true;
			return;
		}
		void this.load(this.lastLoad);
	}

	private async load(options: LoadOptions): Promise<void> {
		if (!this.repos.repositories.some((r) => r.path === options.repo)) {
			this.post({ type: 'error', repo: options.repo, message: `${options.repo} is no longer a known repository.` });
			return;
		}
		const generation = ++this.loadGeneration;
		this.lastLoad = options;
		this.stale = false;
		this.watch(options.repo);
		this.post({ type: 'loading', repo: options.repo });

		try {
			const data = await loadGraphData(this.git, options.repo, graphDataRequest(options));
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
		const webview = this.panel.webview;
		const nonce = randomBytes(16).toString('base64');
		const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', file));
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
<body>
	<div id="app"></div>
	<script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
	}
}
