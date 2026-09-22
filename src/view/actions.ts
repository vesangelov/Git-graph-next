import * as vscode from 'vscode';
import type { GitExecutor } from '../git/executor.ts';
import { GitError, CancelledError } from '../git/executor.ts';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { InvalidActionError, checkRefNames, checkRewrite, describeAction, isCredentialFailure, planAction, rewriteTodo, shellCommand, validateAction } from '../git/actions.ts';
import type { EditorBridge } from '../git/editorBridge.ts';
import { applyPatches, commitPatch, commitSubject, patchFileName, uncommittedPatch } from '../git/patches.ts';
import { actionOptions, integratedTerminalShell } from '../config.ts';
import type { RebaseEditor, RebaseJob } from './rebaseEditor.ts';
import type { GitAction } from '../types.ts';

/** The editor bridge and the UI behind it; null when the bridge could not start. */
export interface RebaseEditing {
	readonly bridge: EditorBridge;
	readonly ui: RebaseEditor;
}

/**
 * Runs write actions (Phase 3) against repositories.
 *
 * Actions on one repository run strictly one after another: two git commands
 * writing at once fight over `index.lock`, and the loser fails with an error
 * that has nothing to do with what the user asked for. Different repositories
 * do not wait for each other.
 */
export class ActionRunner {
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(
		private readonly git: GitExecutor,
		/** Reloads the graph views once an action has changed the repository. */
		private readonly onDidRun: () => void,
		private readonly editing: RebaseEditing | null,
		/** Where every command an action runs, and its outcome, is written (#848). */
		private readonly output: vscode.OutputChannel
	) {}

	/** Runs an action; resolves to null on success, or to the message to show. */
	run(repo: string, action: GitAction): Promise<string | null> {
		const previous = this.queues.get(repo) ?? Promise.resolve();
		const next = previous.then(() => this.execute(repo, action));
		this.queues.set(repo, next.catch(() => undefined));
		return next;
	}

	private async execute(repo: string, action: GitAction): Promise<string | null> {
		try {
			validateAction(action);
		} catch (error) {
			if (error instanceof InvalidActionError) return error.message;
			throw error;
		}
		const invalidName = await checkRefNames(this.git, repo, action);
		if (invalidName !== null) return invalidName;
		if (action.kind === 'rewriteCommits') {
			const unsafe = await checkRewrite(this.git, repo, action);
			if (unsafe !== null) return unsafe;
		}
		if (action.kind === 'createPatch' || action.kind === 'applyPatch') return this.runPatch(repo, action);
		if (action.kind === 'createArchive') return this.runArchive(repo, action);

		const commands = planAction(action, actionOptions());
		const needsEditor = commands.some((command) => command.editor === true);
		if (needsEditor && this.editing === null) return 'Editing in VS Code is unavailable, so this action cannot run here. Run it in a terminal instead.';
		const job = this.rebaseJob(action);
		let registration: vscode.Disposable | undefined;
		if (job !== null && this.editing !== null) {
			const gitDir = (await this.git.runOrNull(repo, ['rev-parse', '--absolute-git-dir']))?.trim();
			if (gitDir === undefined || gitDir === '') return 'Could not find the repository’s git directory.';
			registration = this.editing.ui.register(gitDir, job);
		}
		const network = commands.some((command) => command.network);
		const title = describeAction(action);

		try {
			await vscode.window.withProgress(
				{
					// Network operations and editing sessions can take long and may
					// be cancelled; the rest finish quickly and only need a hint in
					// the status bar.
					location: network || needsEditor ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
					title: `${title}…`,
					cancellable: network || needsEditor
				},
				async (_progress, token) => {
					for (const command of commands) {
						const env = command.editor === true ? this.editing!.bridge.environment() : undefined;
						this.log(repo, shellCommand('git', command.args, false));
						const stdout = await this.git.run(repo, command.args, { token, ...(env !== undefined ? { env } : {}) });
						if (stdout.trim() !== '') this.output.appendLine(indent(stdout));
					}
				}
			);
			return null;
		} catch (error) {
			if (error instanceof CancelledError) return `${title} was cancelled.`;
			const message = error instanceof Error ? error.message : String(error);
			this.output.appendLine(indent(`✗ ${message}`));
			if (error instanceof GitError && network && isCredentialFailure(`${error.stderr}\n${message}`)) {
				void this.offerTerminal(repo, error.args, message);
				return `${message}\n\nGit needed credentials it could not ask for here. Use "Run in Terminal" in the notification, or set up a credential helper or ssh-agent.`;
			}
			return message;
		} finally {
			registration?.dispose();
			// Even a failed action can change the repository (a merge stopped at
			// a conflict is still a merge in progress), so always reload.
			this.onDidRun();
		}
	}

	/** What the editor bridge does with the todo list of an action's rebase, if it has one. */
	private rebaseJob(action: GitAction): RebaseJob | null {
		if (action.kind === 'rewriteCommits') {
			return { transform: (todo) => rewriteTodo(todo, action.commits, action.operation), reviewTodo: action.review };
		}
		if (action.kind === 'rebase' && action.interactive) return { reviewTodo: true };
		return null;
	}

	/**
	 * Creates or applies patches (#538). The file locations come from VS
	 * Code's own dialogs, never from the view; cancelling a dialog is not an
	 * error, the action simply does nothing.
	 */
	private async runPatch(repo: string, action: Extract<GitAction, { kind: 'createPatch' | 'applyPatch' }>): Promise<string | null> {
		try {
			if (action.kind === 'applyPatch') {
				const files = await vscode.window.showOpenDialog({
					canSelectMany: true,
					defaultUri: vscode.Uri.file(repo),
					openLabel: action.mode === 'am' ? 'Apply as Commits' : 'Apply',
					filters: { Patches: ['patch', 'diff', 'mbox', 'eml'], 'All Files': ['*'] }
				});
				if (files === undefined || files.length === 0) return null;
				await applyPatches(this.git, repo, files.map((file) => file.fsPath), action.mode, action.threeWay);
				return null;
			}

			if (action.hashes.length === 0) {
				const patch = await uncommittedPatch(this.git, repo);
				if (patch.length === 0) return 'There are no changes to tracked files to put in a patch.';
				const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(repo, 'uncommitted-changes.patch')), saveLabel: 'Save Patch' });
				if (target === undefined) return null;
				await writeFile(target.fsPath, patch);
				return null;
			}

			if (action.hashes.length === 1) {
				const name = patchFileName(1, await commitSubject(this.git, repo, action.hashes[0]));
				const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(join(repo, name)), saveLabel: 'Save Patch' });
				if (target === undefined) return null;
				await writeFile(target.fsPath, await commitPatch(this.git, repo, action.hashes[0]));
				return null;
			}

			const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, defaultUri: vscode.Uri.file(repo), openLabel: 'Save Patches Here' });
			if (folder === undefined || folder.length === 0) return null;
			for (const [index, hash] of action.hashes.entries()) {
				const name = patchFileName(index + 1, await commitSubject(this.git, repo, hash));
				await writeFile(join(folder[0].fsPath, name), await commitPatch(this.git, repo, hash));
			}
			void vscode.window.showInformationMessage(`Saved ${action.hashes.length} patches to ${folder[0].fsPath}.`);
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		} finally {
			if (action.kind === 'applyPatch') this.onDidRun();
		}
	}

	/** Writes `git archive` of a commit to a file chosen in VS Code's save dialog. */
	private async runArchive(repo: string, action: Extract<GitAction, { kind: 'createArchive' }>): Promise<string | null> {
		const extension = action.format === 'zip' ? 'zip' : 'tar.gz';
		const target = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(join(repo, `${basename(repo)}-${action.hash.slice(0, 8)}.${extension}`)),
			filters: action.format === 'zip' ? { 'Zip archive': ['zip'] } : { 'Gzipped tar archive': ['tar.gz', 'tgz'] },
			saveLabel: 'Create Archive'
		});
		if (target === undefined) return null;
		const args = ['archive', `--format=${action.format === 'zip' ? 'zip' : 'tar.gz'}`, action.hash];
		this.log(repo, `git ${args.join(' ')} > ${target.fsPath}`);
		try {
			await writeFile(target.fsPath, await this.git.runBinary(repo, args));
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	private log(repo: string, line: string): void {
		this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${basename(repo)}: ${line}`);
	}

	/** Offers to run the failed command where git can prompt for credentials. */
	private async offerTerminal(repo: string, args: readonly string[], message: string): Promise<void> {
		const choice = await vscode.window.showErrorMessage(message.split('\n')[0], 'Run in Terminal');
		if (choice !== 'Run in Terminal') return;
		const shell = integratedTerminalShell();
		const terminal = vscode.window.createTerminal({ name: 'Git Graph Next', cwd: repo, ...(shell !== '' ? { shellPath: shell } : {}) });
		terminal.show();
		terminal.sendText(shellCommand(this.git.binary, args, process.platform === 'win32'));
	}
}

/** Indents git's output under the command that produced it. */
function indent(text: string): string {
	return text.trimEnd().split('\n').map((line) => `    ${line}`).join('\n');
}
