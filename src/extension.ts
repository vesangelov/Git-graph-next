import * as vscode from 'vscode';
import { GitExecutor } from './git/executor.ts';
import { RepoManager } from './repoManager.ts';
import { GraphPanel, VIEW_TYPE } from './view/panel.ts';
import { GraphController, type GraphServices } from './view/controller.ts';
import { GraphSidebarProvider, SIDEBAR_VIEW_ID } from './view/sidebar.ts';
import { ChangeItem, ChangesService } from './view/changesView.ts';
import { REVISION_SCHEME, RevisionContentProvider, openChangeDiff, openWorkingFile } from './view/diff.ts';
import { gitPathCandidates, retainContextWhenHidden, showStatusBarItem } from './config.ts';

/**
 * Set as soon as a usable git is found. Menu `when` clauses depend on it, so
 * it must always be set explicitly: a context key that is never set reads as
 * false, which is how a title-bar icon silently disappears (#903).
 */
const ENABLED_CONTEXT = 'gitGraphNext.enabled';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	await vscode.commands.executeCommand('setContext', ENABLED_CONTEXT, false);

	let git: GitExecutor;
	try {
		git = await GitExecutor.locate(gitPathCandidates());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Register the entry points anyway, so using them explains the problem
		// instead of failing with "command not found".
		const explain = () => void vscode.window.showErrorMessage(message, { modal: false });
		for (const id of ['gitGraphNext.view', 'gitGraphNext.viewForRepo', 'gitGraphNext.refresh', 'gitGraphNext.addGitRepository', 'gitGraphNext.removeGitRepository']) {
			context.subscriptions.push(vscode.commands.registerCommand(id, explain));
		}
		void vscode.window.showErrorMessage(message.split('\n')[0]);
		return;
	}

	const repos = new RepoManager(git, context.workspaceState);
	const changes = new ChangesService(git);
	const services: GraphServices = { extensionUri: context.extensionUri, git, repos, changes };
	const sidebar = new GraphSidebarProvider(services);
	context.subscriptions.push(repos, changes, sidebar, { dispose: () => GraphPanel.disposeCurrent() });

	const open = (repo: string | null = null) => GraphPanel.show(services, repo);

	context.subscriptions.push(
		vscode.commands.registerCommand('gitGraphNext.view', () => open()),
		// Same action, separate id so the sidebar title bar can show a distinct icon.
		vscode.commands.registerCommand('gitGraphNext.openFullGraph', () => open()),

		// Invoked from the Explorer context menu with the folder's URI.
		vscode.commands.registerCommand('gitGraphNext.viewForRepo', async (uri?: vscode.Uri) => {
			if (uri === undefined || uri.scheme !== 'file') return open();
			const known = repos.repositoryFor(uri.fsPath);
			const repo = known?.path ?? (await repos.add(uri.fsPath))?.path ?? null;
			if (repo === null) {
				void vscode.window.showWarningMessage(`"${uri.fsPath}" is not inside a Git repository.`);
				return;
			}
			open(repo);
		}),

		vscode.commands.registerCommand('gitGraphNext.refresh', () => GraphController.refreshAll()),

		// Changes view items. Invoked with the clicked item as the argument.
		vscode.commands.registerCommand('gitGraphNext.openChangeDiff', (item?: ChangeItem) => {
			if (item instanceof ChangeItem) return openChangeDiff(item.target, item.change);
		}),
		vscode.commands.registerCommand('gitGraphNext.openChangeFile', (item?: ChangeItem) => {
			if (item instanceof ChangeItem) return openWorkingFile(item.target.repo, item.change.path);
		}),
		vscode.commands.registerCommand('gitGraphNext.copyChangePath', async (item?: ChangeItem) => {
			if (!(item instanceof ChangeItem)) return;
			await vscode.env.clipboard.writeText(item.change.path);
			vscode.window.setStatusBarMessage('Copied path to the clipboard', 3000);
		}),

		vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, new RevisionContentProvider(git)),
		vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, sidebar, { webviewOptions: { retainContextWhenHidden: retainContextWhenHidden() } }),

		vscode.commands.registerCommand('gitGraphNext.addGitRepository', async () => {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Add Repository'
			});
			if (picked === undefined || picked.length === 0) return;
			const repo = await repos.add(picked[0].fsPath);
			if (repo === null) {
				void vscode.window.showErrorMessage(`"${picked[0].fsPath}" is not inside a Git repository.`);
				return;
			}
			void vscode.window.showInformationMessage(`Added "${repo.name}" to Git Graph.`);
		}),

		vscode.commands.registerCommand('gitGraphNext.removeGitRepository', async () => {
			const items = repos.repositories.map((repo) => ({ label: repo.name, description: repo.path, path: repo.path }));
			if (items.length === 0) {
				void vscode.window.showInformationMessage('Git Graph has no repositories to remove.');
				return;
			}
			const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Repository to remove from Git Graph' });
			if (picked !== undefined) await repos.remove(picked.path);
		}),

		vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
			async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
				GraphPanel.revive(panel, services);
			}
		})
	);

	const statusBar = vscode.window.createStatusBarItem('gitGraphNext.status', vscode.StatusBarAlignment.Left, 0);
	statusBar.name = 'Git Graph Next';
	statusBar.text = '$(git-branch) Git Graph';
	statusBar.tooltip = 'View Git Graph';
	statusBar.command = 'gitGraphNext.view';
	const updateStatusBar = () => {
		if (showStatusBarItem() && repos.repositories.length > 0) statusBar.show();
		else statusBar.hide();
	};
	context.subscriptions.push(
		statusBar,
		repos.onDidChange(updateStatusBar),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('git-graph-next.showStatusBarItem')) updateStatusBar();
		})
	);

	await vscode.commands.executeCommand('setContext', ENABLED_CONTEXT, true);
	await repos.initialise();
	updateStatusBar();
}

export function deactivate(): void {
	/* Everything is released through context.subscriptions. */
}
