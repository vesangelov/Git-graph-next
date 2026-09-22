import * as vscode from 'vscode';
import { retainContextWhenHidden } from '../config.ts';
import { GraphController, webviewOptions, type GraphServices } from './controller.ts';
import type { FilterState } from './protocol.ts';

export const VIEW_TYPE = 'gitGraphNext.view';

/**
 * A Git Graph editor tab. Opening the graph reveals the one last used;
 * "Open Git Graph in New Tab" adds another, so two repositories — or two
 * places in one history — can be looked at side by side (#610, #747).
 */
export class GraphPanel implements vscode.Disposable {
	private static readonly panels = new Set<GraphPanel>();
	/** The tab that acted last: what commands without a tab of their own use. */
	private static active: GraphPanel | undefined;

	private readonly controller: GraphController;
	private readonly disposables: vscode.Disposable[] = [];

	/** Opens the graph, or reveals the last used tab, optionally switching repository and filter. */
	static show(services: GraphServices, repo: string | null = null, filter: Partial<FilterState> | null = null): void {
		const panel = GraphPanel.active ?? GraphPanel.create(services, repo);
		GraphPanel.active = panel;
		panel.panel.reveal();
		if (repo !== null && filter !== null) panel.controller.applyFilter(repo, filter);
		else if (repo !== null) panel.controller.selectRepo(repo);
	}

	/** Opens one more graph tab, beside the current one (#610). */
	static showNew(services: GraphServices, repo: string | null = null): void {
		const panel = GraphPanel.create(services, repo, vscode.ViewColumn.Beside);
		GraphPanel.active = panel;
		panel.panel.reveal();
	}

	/** Scrolls the graph to a commit, opening a tab first if there is none. */
	static reveal(services: GraphServices, repo: string, hash: string, label: string): void {
		GraphPanel.show(services, repo);
		GraphPanel.active?.controller.revealCommit(repo, hash, label);
	}

	/** Re-attaches to a tab VS Code restored after a reload or restart (#675). */
	static revive(panel: vscode.WebviewPanel, services: GraphServices): void {
		panel.webview.options = webviewOptions(services.extensionUri);
		GraphPanel.active = new GraphPanel(panel, services, null);
	}

	static disposeAll(): void {
		for (const panel of [...GraphPanel.panels]) panel.dispose();
	}

	private static create(services: GraphServices, repo: string | null, column = vscode.ViewColumn.One): GraphPanel {
		const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Git Graph', column, {
			...webviewOptions(services.extensionUri),
			retainContextWhenHidden: retainContextWhenHidden()
		});
		return new GraphPanel(panel, services, repo);
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		services: GraphServices,
		initialRepo: string | null
	) {
		GraphPanel.panels.add(this);
		panel.iconPath = vscode.Uri.joinPath(services.extensionUri, 'media', 'icon.png');
		this.controller = new GraphController(
			{ webview: panel.webview, get visible() { return panel.visible; }, onDidChangeVisibility: panel.onDidChangeViewState },
			services,
			'panel',
			initialRepo
		);
		this.disposables.push(
			this.controller,
			panel.onDidDispose(() => this.dispose()),
			panel.onDidChangeViewState(() => {
				if (panel.active) GraphPanel.active = this;
			})
		);
	}

	dispose(): void {
		GraphPanel.panels.delete(this);
		if (GraphPanel.active === this) GraphPanel.active = [...GraphPanel.panels][0];
		for (const disposable of this.disposables.splice(0)) disposable.dispose();
		this.panel.dispose();
	}
}
