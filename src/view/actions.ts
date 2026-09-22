import * as vscode from 'vscode';
import type { GitExecutor } from '../git/executor.ts';
import { GitError, CancelledError } from '../git/executor.ts';
import { InvalidActionError, checkRefNames, describeAction, isCredentialFailure, planAction, shellCommand, validateAction } from '../git/actions.ts';
import { actionOptions, integratedTerminalShell } from '../config.ts';
import type { GitAction } from '../types.ts';

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
		private readonly onDidRun: () => void
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

		const commands = planAction(action, actionOptions());
		const network = commands.some((command) => command.network);
		const title = describeAction(action);

		try {
			await vscode.window.withProgress(
				{
					// Network operations can take long and may be cancelled; local
					// ones finish quickly and only need a hint in the status bar.
					location: network ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
					title: `${title}…`,
					cancellable: network
				},
				async (_progress, token) => {
					for (const command of commands) await this.git.run(repo, command.args, { token });
				}
			);
			return null;
		} catch (error) {
			if (error instanceof CancelledError) return `${title} was cancelled.`;
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof GitError && network && isCredentialFailure(`${error.stderr}\n${message}`)) {
				void this.offerTerminal(repo, error.args, message);
				return `${message}\n\nGit needed credentials it could not ask for here. Use "Run in Terminal" in the notification, or set up a credential helper or ssh-agent.`;
			}
			return message;
		} finally {
			// Even a failed action can change the repository (a merge stopped at
			// a conflict is still a merge in progress), so always reload.
			this.onDidRun();
		}
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
