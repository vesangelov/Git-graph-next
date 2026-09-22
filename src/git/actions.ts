import type { GitExecutor } from './executor.ts';
import { PendingOperation, type GitAction } from '../types.ts';

/** One git invocation of an action. */
export interface GitCommand {
	readonly args: readonly string[];
	/** Talks to a remote: may be slow, may need credentials, can be cancelled. */
	readonly network: boolean;
}

/** Options that come from settings rather than from the action itself. */
export interface ActionOptions {
	/** `git-graph-next.repository.sign.commits`: sign merges, cherry-picks, reverts. */
	readonly signCommits: boolean;
	/** `git-graph-next.repository.sign.tags`: create annotated tags signed. */
	readonly signTags: boolean;
}

export class InvalidActionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidActionError';
	}
}

const HASH = /^[0-9a-f]{40}$/;
const STASH = /^stash@\{\d+\}$/;

/**
 * Checks the shape of every value an action carries, before anything runs.
 *
 * Actions arrive from the webview, which is not trusted to have built them
 * correctly. The one property that matters most: no value may begin with `-`,
 * or git would read it as an option (`--upload-pack=…` is a code execution
 * vector). Ref names are also checked by `git check-ref-format` when they are
 * new; existing names only need to look like names.
 */
export function validateAction(action: GitAction): void {
	const ref = (value: unknown, what: string) => {
		if (typeof value !== 'string' || value === '' || value.startsWith('-') || /[\0-\x1f\x7f]/.test(value)) {
			throw new InvalidActionError(`Invalid ${what}: ${JSON.stringify(value)}`);
		}
	};
	const hash = (value: unknown) => {
		if (typeof value !== 'string' || !HASH.test(value)) throw new InvalidActionError(`Invalid commit hash: ${JSON.stringify(value)}`);
	};
	const optionalRemote = (value: unknown) => {
		if (value !== null) ref(value, 'remote');
	};
	const stash = (value: unknown) => {
		if (typeof value !== 'string' || !STASH.test(value)) throw new InvalidActionError(`Invalid stash: ${JSON.stringify(value)}`);
	};
	const mainline = (value: unknown) => {
		if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1)) throw new InvalidActionError('Invalid parent number');
	};
	const operation = (value: unknown) => {
		if (!Object.values(PendingOperation).includes(value as PendingOperation)) throw new InvalidActionError(`Invalid operation: ${JSON.stringify(value)}`);
	};

	switch (action.kind) {
		case 'checkout':
			return ref(action.branch, 'branch');
		case 'checkoutDetached':
			return hash(action.hash);
		case 'checkoutRemote':
			ref(action.remoteBranch, 'remote branch');
			return ref(action.localName, 'branch name');
		case 'createBranch':
			ref(action.name, 'branch name');
			return hash(action.startPoint);
		case 'deleteBranch':
			ref(action.name, 'branch');
			return optionalRemote(action.deleteOnRemote);
		case 'renameBranch':
			ref(action.from, 'branch');
			return ref(action.to, 'branch name');
		case 'deleteRemoteBranch':
			ref(action.remote, 'remote');
			return ref(action.branch, 'branch');
		case 'createTag':
			ref(action.name, 'tag name');
			hash(action.target);
			if (action.message !== null && typeof action.message !== 'string') throw new InvalidActionError('Invalid tag message');
			return optionalRemote(action.pushTo);
		case 'deleteTag':
			ref(action.name, 'tag');
			return optionalRemote(action.deleteOnRemote);
		case 'pushTag':
			ref(action.name, 'tag');
			return ref(action.remote, 'remote');
		case 'fetch':
			return optionalRemote(action.remote);
		case 'pull':
			if (!['merge', 'rebase', 'ff-only'].includes(action.mode)) throw new InvalidActionError('Invalid pull mode');
			return;
		case 'push':
			ref(action.branch, 'branch');
			ref(action.remote, 'remote');
			if (!['none', 'with-lease', 'force'].includes(action.force)) throw new InvalidActionError('Invalid force mode');
			return;
		case 'merge':
			return ref(action.ref, 'branch or commit');
		case 'rebase':
			return ref(action.onto, 'branch or commit');
		case 'cherryPick':
			hash(action.hash);
			return mainline(action.mainline);
		case 'revert':
			hash(action.hash);
			return mainline(action.mainline);
		case 'reset':
			hash(action.hash);
			if (!['soft', 'mixed', 'hard'].includes(action.mode)) throw new InvalidActionError('Invalid reset mode');
			return;
		case 'stashPush':
			if (typeof action.message !== 'string') throw new InvalidActionError('Invalid stash message');
			return;
		case 'stashApply':
		case 'stashPop':
		case 'stashDrop':
			return stash(action.selector);
		case 'stashBranch':
			stash(action.selector);
			return ref(action.name, 'branch name');
		case 'discardChanges':
		case 'cleanUntracked':
			return;
		case 'continueOperation':
		case 'abortOperation':
			return operation(action.operation);
		default:
			throw new InvalidActionError(`Unknown action ${JSON.stringify((action as { kind?: unknown }).kind)}`);
	}
}

/** New ref names an action would create, for `git check-ref-format`. */
export function newRefNames(action: GitAction): { kind: 'branch' | 'tag'; name: string }[] {
	switch (action.kind) {
		case 'checkoutRemote':
			return [{ kind: 'branch', name: action.localName }];
		case 'createBranch':
		case 'stashBranch':
			return [{ kind: 'branch', name: action.name }];
		case 'renameBranch':
			return [{ kind: 'branch', name: action.to }];
		case 'createTag':
			return [{ kind: 'tag', name: action.name }];
		default:
			return [];
	}
}

/**
 * Checks new ref names with git itself, so the rules are exactly git's
 * (no `..`, no trailing `.lock`, no `~^:?*[\`, …). Resolves to an error
 * message, or null when all names are valid.
 */
export async function checkRefNames(git: GitExecutor, repo: string, action: GitAction): Promise<string | null> {
	for (const { kind, name } of newRefNames(action)) {
		const args = kind === 'branch' ? ['check-ref-format', '--branch', name] : ['check-ref-format', `refs/tags/${name}`];
		if ((await git.runOrNull(repo, args)) === null) return `"${name}" is not a valid ${kind} name.`;
	}
	return null;
}

const sign = (enabled: boolean) => (enabled ? ['--gpg-sign'] : []);
const local = (...args: string[]): GitCommand => ({ args, network: false });
const remote = (...args: string[]): GitCommand => ({ args, network: true });

/** The git commands that perform an action, in order. Assumes `validateAction` passed. */
export function planAction(action: GitAction, options: ActionOptions): GitCommand[] {
	switch (action.kind) {
		case 'checkout':
			// The trailing `--` makes git read the name as a branch, never as a path.
			return [local('checkout', action.branch, '--')];
		case 'checkoutDetached':
			return [local('checkout', '--detach', action.hash, '--')];
		case 'checkoutRemote':
			return [local('checkout', '-b', action.localName, '--track', action.remoteBranch, '--')];
		case 'createBranch':
			return action.checkout
				? [local('checkout', action.force ? '-B' : '-b', action.name, action.startPoint, '--')]
				: [local('branch', ...(action.force ? ['--force'] : []), action.name, action.startPoint)];
		case 'deleteBranch':
			return [
				local('branch', action.force ? '-D' : '-d', action.name),
				...(action.deleteOnRemote !== null ? [remote('push', action.deleteOnRemote, '--delete', `refs/heads/${action.name}`)] : [])
			];
		case 'renameBranch':
			return [local('branch', '-m', action.from, action.to)];
		case 'deleteRemoteBranch':
			return [remote('push', action.remote, '--delete', `refs/heads/${action.branch}`)];
		case 'createTag': {
			const force = action.force ? ['--force'] : [];
			const create =
				action.message === null
					? local('tag', ...force, action.name, action.target)
					: local('tag', ...force, options.signTags ? '--sign' : '--annotate', '--message', action.message, action.name, action.target);
			return [create, ...(action.pushTo !== null ? [remote('push', action.pushTo, `refs/tags/${action.name}`)] : [])];
		}
		case 'deleteTag':
			return [
				local('tag', '--delete', action.name),
				...(action.deleteOnRemote !== null ? [remote('push', action.deleteOnRemote, '--delete', `refs/tags/${action.name}`)] : [])
			];
		case 'pushTag':
			return [remote('push', action.remote, `refs/tags/${action.name}`)];
		case 'fetch': {
			const prune = action.prune ? ['--prune', ...(action.pruneTags ? ['--prune-tags'] : [])] : [];
			return [remote('fetch', ...(action.remote === null ? ['--all'] : [action.remote]), ...prune)];
		}
		case 'pull':
			return [remote('pull', action.mode === 'rebase' ? '--rebase' : action.mode === 'ff-only' ? '--ff-only' : '--no-rebase')];
		case 'push': {
			const force = action.force === 'with-lease' ? ['--force-with-lease'] : action.force === 'force' ? ['--force'] : [];
			// An explicit refspec: pushes exactly this branch, whatever push.default says.
			const refspec = `refs/heads/${action.branch}:refs/heads/${action.branch}`;
			return [remote('push', ...(action.setUpstream ? ['--set-upstream'] : []), ...force, action.remote, refspec)];
		}
		case 'merge':
			return [
				local(
					'merge',
					'--no-edit',
					...(action.squash ? ['--squash'] : action.noFastForward ? ['--no-ff'] : []),
					...(action.noCommit && !action.squash ? ['--no-commit'] : []),
					...sign(options.signCommits),
					action.ref
				)
			];
		case 'rebase':
			return [local('rebase', ...sign(options.signCommits), action.onto)];
		case 'cherryPick':
			return [
				local(
					'cherry-pick',
					...(action.mainline !== null ? ['--mainline', String(action.mainline)] : []),
					...(action.noCommit ? ['--no-commit'] : []),
					...(action.recordOrigin ? ['-x'] : []),
					...sign(options.signCommits && !action.noCommit),
					action.hash
				)
			];
		case 'revert':
			return [
				local('revert', '--no-edit', ...(action.mainline !== null ? ['--mainline', String(action.mainline)] : []), ...sign(options.signCommits), action.hash)
			];
		case 'reset':
			return [local('reset', `--${action.mode}`, action.hash, '--')];
		case 'stashPush':
			return [local('stash', 'push', ...(action.includeUntracked ? ['--include-untracked'] : []), ...(action.message !== '' ? ['--message', action.message] : []))];
		case 'stashApply':
			return [local('stash', 'apply', ...(action.reinstateIndex ? ['--index'] : []), action.selector)];
		case 'stashPop':
			return [local('stash', 'pop', ...(action.reinstateIndex ? ['--index'] : []), action.selector)];
		case 'stashDrop':
			return [local('stash', 'drop', action.selector)];
		case 'stashBranch':
			return [local('stash', 'branch', action.name, action.selector)];
		case 'discardChanges':
			return [local('reset', '--hard', 'HEAD', '--')];
		case 'cleanUntracked':
			return [local('clean', '--force', ...(action.directories ? ['-d'] : []))];
		case 'continueOperation':
			return action.operation === PendingOperation.Bisect ? [] : [local(action.operation, '--continue')];
		case 'abortOperation':
			return [action.operation === PendingOperation.Bisect ? local('bisect', 'reset') : local(action.operation, '--abort')];
	}
}

/** A short present-tense description, for progress messages. */
export function describeAction(action: GitAction): string {
	switch (action.kind) {
		case 'checkout':
			return `Checking out ${action.branch}`;
		case 'checkoutDetached':
			return `Checking out ${action.hash.slice(0, 8)}`;
		case 'checkoutRemote':
			return `Checking out ${action.remoteBranch} as ${action.localName}`;
		case 'createBranch':
			return `Creating branch ${action.name}`;
		case 'deleteBranch':
			return `Deleting branch ${action.name}`;
		case 'renameBranch':
			return `Renaming ${action.from} to ${action.to}`;
		case 'deleteRemoteBranch':
			return `Deleting ${action.remote}/${action.branch}`;
		case 'createTag':
			return `Creating tag ${action.name}`;
		case 'deleteTag':
			return `Deleting tag ${action.name}`;
		case 'pushTag':
			return `Pushing tag ${action.name} to ${action.remote}`;
		case 'fetch':
			return action.remote === null ? 'Fetching from all remotes' : `Fetching from ${action.remote}`;
		case 'pull':
			return 'Pulling';
		case 'push':
			return `Pushing ${action.branch} to ${action.remote}`;
		case 'merge':
			return `Merging ${action.ref}`;
		case 'rebase':
			return `Rebasing onto ${action.onto}`;
		case 'cherryPick':
			return `Cherry-picking ${action.hash.slice(0, 8)}`;
		case 'revert':
			return `Reverting ${action.hash.slice(0, 8)}`;
		case 'reset':
			return `Resetting to ${action.hash.slice(0, 8)}`;
		case 'stashPush':
			return 'Stashing changes';
		case 'stashApply':
			return `Applying ${action.selector}`;
		case 'stashPop':
			return `Popping ${action.selector}`;
		case 'stashDrop':
			return `Dropping ${action.selector}`;
		case 'stashBranch':
			return `Creating branch ${action.name} from ${action.selector}`;
		case 'discardChanges':
			return 'Discarding changes';
		case 'cleanUntracked':
			return 'Removing untracked files';
		case 'continueOperation':
			return `Continuing ${action.operation}`;
		case 'abortOperation':
			return `Aborting ${action.operation}`;
	}
}

/**
 * True when a failure looks like git needed credentials it could not ask for.
 * Prompts are disabled (a hidden prompt would hang forever), so the view
 * offers to run the same command in a terminal, where they can be answered.
 */
export function isCredentialFailure(stderr: string): boolean {
	return /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey|Host key verification failed|passphrase/i.test(stderr);
}

/** Quotes arguments for a POSIX shell or PowerShell, for "Run in Terminal". */
export function shellCommand(binary: string, args: readonly string[], windows: boolean): string {
	const quote = windows
		? (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`)
		: (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
	const exe = quote(binary);
	// PowerShell needs the call operator to run a quoted executable path.
	return `${windows && exe.startsWith("'") ? '& ' : ''}${exe} ${args.map(quote).join(' ')}`;
}
