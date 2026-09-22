import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, normalize, sep } from 'node:path';

/** What to do with the todo list of one running rebase. */
export interface RebaseJob {
	/** Rewrites git's todo list before anything else happens; throwing cancels the rebase. */
	readonly transform?: (todo: string) => string;
	/** Show the (rewritten) todo list for editing; otherwise start at once. */
	readonly reviewTodo: boolean;
}

interface Review {
	readonly file: string;
	finish(ok: boolean): void;
}

/**
 * Where git's editors open (#757): a rebase todo list or a commit message in a
 * normal VS Code editor, with Start / Cancel in the status bar and a
 * notification. Closing the tab counts as done, as with `code --wait`.
 */
export class RebaseEditor implements vscode.Disposable {
	private readonly jobs = new Map<string, RebaseJob>();
	private readonly reviews: Review[] = [];
	private readonly accept: vscode.StatusBarItem;
	private readonly cancel: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.accept = vscode.window.createStatusBarItem('gitGraphNext.editor.accept', vscode.StatusBarAlignment.Left, 1000);
		this.cancel = vscode.window.createStatusBarItem('gitGraphNext.editor.cancel', vscode.StatusBarAlignment.Left, 999);
		this.accept.command = 'gitGraphNext.editor.accept';
		this.cancel.command = 'gitGraphNext.editor.cancel';
		this.cancel.text = '$(close) Cancel';
		this.accept.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
		this.disposables.push(
			this.accept,
			this.cancel,
			vscode.commands.registerCommand('gitGraphNext.editor.accept', () => this.reviews.at(-1)?.finish(true)),
			vscode.commands.registerCommand('gitGraphNext.editor.cancel', () => this.reviews.at(-1)?.finish(false)),
			vscode.window.tabGroups.onDidChangeTabs((event) => {
				for (const tab of event.closed) {
					if (!(tab.input instanceof vscode.TabInputText)) continue;
					const closed = normalize(tab.input.uri.fsPath);
					this.reviews.find((review) => review.file === closed)?.finish(true);
				}
			})
		);
	}

	/**
	 * Registers what to do with the todo list of the rebase about to run in
	 * the repository whose git directory is `gitDir`. Dispose when it ends.
	 */
	register(gitDir: string, job: RebaseJob): vscode.Disposable {
		const key = normalize(gitDir);
		this.jobs.set(key, job);
		return new vscode.Disposable(() => {
			if (this.jobs.get(key) === job) this.jobs.delete(key);
		});
	}

	/** Called by the editor bridge for each file git wants edited. */
	async handle(requested: string): Promise<boolean> {
		const file = normalize(requested);
		const isTodo = basename(file) === 'git-rebase-todo';
		if (isTodo) {
			const job = [...this.jobs].find(([gitDir]) => file.startsWith(gitDir + sep))?.[1];
			if (job?.transform !== undefined) {
				try {
					await writeFile(file, job.transform(await readFile(file, 'utf8')), 'utf8');
				} catch (error) {
					void vscode.window.showErrorMessage(`The rebase was not started: ${error instanceof Error ? error.message : String(error)}`);
					return false;
				}
			}
			if (job !== undefined && !job.reviewTodo) return true;
		}
		return this.review(file, isTodo);
	}

	private async review(file: string, isTodo: boolean): Promise<boolean> {
		const uri = vscode.Uri.file(file);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: false });

		const acceptLabel = isTodo ? 'Start Rebase' : 'Use This Message';
		const explanation = isTodo
			? 'Edit the rebase list — reorder lines, change pick to reword, squash, fixup, edit or drop — then Start Rebase. Closing the editor starts it too.'
			: 'Edit the commit message, then Use This Message. Closing the editor uses it too.';

		return new Promise<boolean>((resolve) => {
			let done = false;
			const review: Review = {
				file,
				finish: (ok) => {
					if (done) return;
					done = true;
					this.reviews.splice(this.reviews.indexOf(review), 1);
					this.updateStatusBar();
					void (async () => {
						if (ok && document.isDirty) await document.save();
						// Close the tab we opened; it has served its purpose.
						for (const group of vscode.window.tabGroups.all) {
							for (const tab of group.tabs) {
								if (tab.input instanceof vscode.TabInputText && normalize(tab.input.uri.fsPath) === file) await vscode.window.tabGroups.close(tab, true);
							}
						}
						resolve(ok);
					})();
				}
			};
			this.reviews.push(review);
			this.accept.text = `$(check) ${acceptLabel}`;
			this.updateStatusBar();
			void vscode.window.showInformationMessage(explanation, acceptLabel, 'Cancel').then((choice) => {
				if (choice === acceptLabel) review.finish(true);
				else if (choice === 'Cancel') review.finish(false);
			});
		});
	}

	private updateStatusBar(): void {
		if (this.reviews.length > 0) {
			this.accept.show();
			this.cancel.show();
		} else {
			this.accept.hide();
			this.cancel.hide();
		}
	}

	dispose(): void {
		for (const review of [...this.reviews]) review.finish(false);
		for (const disposable of this.disposables) disposable.dispose();
	}
}
