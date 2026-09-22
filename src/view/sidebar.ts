import * as vscode from 'vscode';
import { GraphController, webviewOptions, type GraphServices } from './controller.ts';

export const SIDEBAR_VIEW_ID = 'gitGraphNext.graphView';

/**
 * The compact graph in the Activity Bar container (#781). Selecting a commit
 * fills the Changes view beneath it.
 */
export class GraphSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private controller: GraphController | undefined;

	constructor(private readonly services: GraphServices) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.controller?.dispose();
		view.webview.options = webviewOptions(this.services.extensionUri);
		const controller = new GraphController(
			{ webview: view.webview, get visible() { return view.visible; }, onDidChangeVisibility: view.onDidChangeVisibility },
			this.services,
			'sidebar'
		);
		this.controller = controller;
		view.onDidDispose(() => {
			controller.dispose();
			if (this.controller === controller) this.controller = undefined;
		});
	}

	toggleCompact(): void {
		this.controller?.toggleCompact();
	}

	dispose(): void {
		this.controller?.dispose();
	}
}
