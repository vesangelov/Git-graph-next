import * as vscode from 'vscode';
import { retainContextWhenHidden } from '../config.ts';
import { GraphController, webviewOptions, type GraphServices } from './controller.ts';

export const VIEW_TYPE = 'gitGraphNext.view';

/**
 * The Git Graph editor panel. At most one exists; opening the graph again
 * reveals it and, when a repository is named, switches to that repository.
 */
export class GraphPanel implements vscode.Disposable {
	private static current: GraphPanel | undefined;

	private readonly controller: GraphController;
	private readonly disposables: vscode.Disposable[] = [];

	/** Opens the graph, or reveals it, optionally switching repository. */
	static show(services: GraphServices, repo: string | null = null): void {
		if (GraphPanel.current !== undefined) {
			GraphPanel.current.panel.reveal();
			if (repo !== null) GraphPanel.current.controller.selectRepo(repo);
			return;
		}
		const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Git Graph', vscode.ViewColumn.One, {
			...webviewOptions(services.extensionUri),
			retainContextWhenHidden: retainContextWhenHidden()
		});
		GraphPanel.current = new GraphPanel(panel, services, repo);
	}

	/** Re-attaches to a panel VS Code restored after a reload or restart. */
	static revive(panel: vscode.WebviewPanel, services: GraphServices): void {
		GraphPanel.current?.dispose();
		panel.webview.options = webviewOptions(services.extensionUri);
		GraphPanel.current = new GraphPanel(panel, services, null);
	}

	static disposeCurrent(): void {
		GraphPanel.current?.dispose();
	}

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		services: GraphServices,
		initialRepo: string | null
	) {
		panel.iconPath = vscode.Uri.joinPath(services.extensionUri, 'media', 'icon.png');
		this.controller = new GraphController(
			{ webview: panel.webview, get visible() { return panel.visible; }, onDidChangeVisibility: panel.onDidChangeViewState },
			services,
			'panel',
			initialRepo
		);
		this.disposables.push(this.controller, panel.onDidDispose(() => this.dispose()));
	}

	dispose(): void {
		if (GraphPanel.current === this) GraphPanel.current = undefined;
		for (const disposable of this.disposables.splice(0)) disposable.dispose();
		this.panel.dispose();
	}
}
