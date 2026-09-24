import type { GitExecutor } from './executor.ts';
import { PendingOperation, isFullHash, type GitAction } from '../types.ts';

/** One git invocation of an action. */
export interface GitCommand {
	readonly args: readonly string[];
	/** Talks to a remote: may be slow, may need credentials, can be cancelled. */
	readonly network: boolean;
	/**
	 * May open git's editors (a rebase todo list, a commit message): they are
	 * routed to VS Code through the editor bridge instead of accepted as is.
	 */
	readonly editor?: boolean;
}

/** Options that come from settings rather than from the action itself. */
export interface ActionOptions {
	/** `git-graph-next.repository.sign.commits`: sign merges, cherry-picks, reverts. */
	readonly signCommits: boolean;
	/** `git-graph-next.repository.sign.tags`: create annotated tags signed. */
	readonly signTags: boolean;
	/**
	 * Add `--force-if-includes` to `--force-with-lease` (git 2.30+). Without it
	 * the lease is checked against the remote-tracking branch, which any
	 * background fetch moves to the remote's tip — after which the push
	 * overwrites commits nobody here has seen, exactly like `--force`.
	 */
	readonly forceIfIncludes: boolean;
}

export class InvalidActionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidActionError';
	}
}

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
		if (!isFullHash(value)) throw new InvalidActionError(`Invalid commit hash: ${JSON.stringify(value)}`);
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
	const hashes = (value: unknown, min: number) => {
		if (!Array.isArray(value) || value.length < min) throw new InvalidActionError(`At least ${min} commits are needed`);
		for (const item of value) hash(item);
		if (new Set(value).size !== value.length) throw new InvalidActionError('A commit is listed twice');
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
		case 'addRemote':
		case 'setRemoteUrl':
			ref(action.name, 'remote name');
			return ref(action.url, 'remote URL');
		case 'removeRemote':
			return ref(action.name, 'remote');
		case 'setUserConfig':
			for (const value of [action.name, action.email]) {
				if (typeof value !== 'string' || /[\0\n\r]/.test(value)) throw new InvalidActionError('Invalid user name or e-mail');
			}
			return;
		case 'createArchive':
			hash(action.hash);
			if (action.format !== 'zip' && action.format !== 'tar.gz') throw new InvalidActionError('Invalid archive format');
			return;
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
			if (action.onto !== null) ref(action.onto, 'branch or commit');
			return;
		case 'commitFixup':
			hash(action.target);
			if (action.mode !== 'fixup' && action.mode !== 'squash') throw new InvalidActionError('Invalid fixup mode');
			return;
		case 'rewriteCommits':
			hashes(action.commits, action.operation === 'drop' ? 1 : 2);
			if (action.base !== null) hash(action.base);
			if (!['squash', 'fixup', 'drop'].includes(action.operation)) throw new InvalidActionError('Invalid rewrite');
			return;
		case 'cherryPickMany':
		case 'revertMany':
			return hashes(action.hashes, 1);
		case 'deleteBranches':
			if (!Array.isArray(action.names) || action.names.length === 0) throw new InvalidActionError('No branches to delete');
			for (const name of action.names) ref(name, 'branch');
			return;
		case 'createPatch':
			return hashes(action.hashes, 0);
		case 'applyPatch':
			if (action.mode !== 'apply' && action.mode !== 'am') throw new InvalidActionError('Invalid patch mode');
			return;
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
		case 'stageAll':
		case 'unstageAll':
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
			return [remote('push', ...(action.force ? ['--force'] : []), action.remote, `refs/tags/${action.name}`)];
		case 'fetch': {
			const prune = action.prune ? ['--prune', ...(action.pruneTags ? ['--prune-tags'] : [])] : [];
			return [remote('fetch', ...(action.remote === null ? ['--all'] : [action.remote]), ...prune, ...(action.noTags ? ['--no-tags'] : []))];
		}
		case 'addRemote':
			return [local('remote', 'add', action.name, action.url), ...(action.fetch ? [remote('fetch', action.name)] : [])];
		case 'setRemoteUrl':
			return [local('remote', 'set-url', action.name, action.url)];
		case 'removeRemote':
			return [local('remote', 'remove', action.name)];
		case 'setUserConfig':
			// An empty value removes the repository's own setting, so the global one applies again.
			return [
				action.name === '' ? local('config', '--local', '--unset-all', 'user.name') : local('config', '--local', 'user.name', action.name),
				action.email === '' ? local('config', '--local', '--unset-all', 'user.email') : local('config', '--local', 'user.email', action.email)
			];
		case 'createArchive':
			// File-based: the host asks where to write.
			return [];
		case 'pull':
			return [remote('pull', action.mode === 'rebase' ? '--rebase' : action.mode === 'ff-only' ? '--ff-only' : '--no-rebase')];
		case 'push': {
			const lease = ['--force-with-lease', ...(options.forceIfIncludes ? ['--force-if-includes'] : [])];
			const force = action.force === 'with-lease' ? lease : action.force === 'force' ? ['--force'] : [];
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
		case 'rebase': {
			const onto = action.onto === null ? ['--root'] : [action.onto];
			if (!action.interactive && !action.autosquash) return [local('rebase', ...sign(options.signCommits), ...onto)];
			// Autosquash needs an interactive rebase; without review the default
			// sequence editor (`true`) accepts git's rearranged list as it is.
			return [
				{
					args: ['rebase', '--interactive', ...(action.autosquash ? ['--autosquash'] : ['--no-autosquash']), ...sign(options.signCommits), ...onto],
					network: false,
					editor: action.interactive
				}
			];
		}
		case 'commitFixup':
			return [
				{
					args: ['commit', action.mode === 'fixup' ? `--fixup=${action.target}` : `--squash=${action.target}`, ...(action.all ? ['--all'] : []), ...sign(options.signCommits)],
					network: false,
					// A squash! commit asks for a message; a fixup! commit does not.
					editor: action.mode === 'squash'
				}
			];
		case 'rewriteCommits':
			return [
				{
					args: ['rebase', '--interactive', '--no-autosquash', ...sign(options.signCommits), ...(action.base === null ? ['--root'] : [action.base])],
					network: false,
					editor: true
				}
			];
		case 'cherryPickMany':
			return [local('cherry-pick', ...(action.noCommit ? ['--no-commit'] : []), ...(action.recordOrigin ? ['-x'] : []), ...sign(options.signCommits && !action.noCommit), ...action.hashes)];
		case 'revertMany':
			return [local('revert', '--no-edit', ...sign(options.signCommits), ...action.hashes)];
		case 'deleteBranches':
			return [local('branch', action.force ? '-D' : '-d', ...action.names)];
		case 'createPatch':
		case 'applyPatch':
			// File-based: run by the host, which asks where to write or what to read.
			return [];
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
			// No trailing `--`: with it this is the "reset paths" form, which
			// older git versions refuse to combine with --hard.
			return [local('reset', `--${action.mode}`, action.hash)];
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
		case 'stageAll':
			return [local('add', '--all', '--')];
		case 'unstageAll':
			return [local('reset', '--mixed', 'HEAD')];
		case 'discardChanges':
			return [local('reset', '--hard', 'HEAD')];
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
		case 'addRemote':
			return `Adding remote ${action.name}`;
		case 'setRemoteUrl':
			return `Changing the URL of ${action.name}`;
		case 'removeRemote':
			return `Removing remote ${action.name}`;
		case 'setUserConfig':
			return 'Setting the user for this repository';
		case 'createArchive':
			return `Creating an archive of ${action.hash.slice(0, 8)}`;
		case 'fetch':
			return action.remote === null ? 'Fetching from all remotes' : `Fetching from ${action.remote}`;
		case 'pull':
			return 'Pulling';
		case 'push':
			return `Pushing ${action.branch} to ${action.remote}`;
		case 'merge':
			return `Merging ${action.ref}`;
		case 'rebase':
			return action.interactive ? 'Interactive rebase (edit the list in the editor)' : action.onto === null ? 'Rebasing from the root' : `Rebasing onto ${action.onto}`;
		case 'commitFixup':
			return `Creating a ${action.mode}! commit for ${action.target.slice(0, 8)}`;
		case 'rewriteCommits':
			return `${action.operation === 'drop' ? 'Dropping' : 'Squashing'} ${action.commits.length} commit${action.commits.length === 1 ? '' : 's'}`;
		case 'cherryPickMany':
			return `Cherry-picking ${action.hashes.length} commits`;
		case 'revertMany':
			return `Reverting ${action.hashes.length} commits`;
		case 'deleteBranches':
			return `Deleting ${action.names.length} branch${action.names.length === 1 ? '' : 'es'}`;
		case 'createPatch':
			return 'Creating patches';
		case 'applyPatch':
			return action.mode === 'am' ? 'Applying patches as commits' : 'Applying patches';
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
		case 'stageAll':
			return 'Staging all changes';
		case 'unstageAll':
			return 'Unstaging all changes';
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
 * Rewrites git's own interactive-rebase todo list for a squash, fixup or drop
 * of chosen commits (#182), so every other line — and any option git applied
 * while building the list — stays exactly as git wrote it.
 *
 * Todo lines name commits by abbreviated hash (`pick 2da6cfd # subject`), so
 * they are matched by prefix. For squash / fixup the later commits move to
 * just after the first (oldest) one, which keeps its `pick`. Throws when a
 * commit is not in the list: the rebase is then cancelled untouched.
 */
export function rewriteTodo(todo: string, commits: readonly string[], operation: 'squash' | 'fixup' | 'drop'): string {
	const lines = todo.split('\n');
	const pick = /^(?:pick|p)\s+([0-9a-f]{4,64})\b/;
	const indexOf = (commit: string) =>
		lines.findIndex((line) => {
			const match = pick.exec(line);
			return match !== null && commit.startsWith(match[1]);
		});
	const positions = commits.map(indexOf);
	const missing = commits.find((_, i) => positions[i] === -1);
	if (missing !== undefined) throw new Error(`Commit ${missing.slice(0, 8)} is not in the rebase list`);

	const retag = (line: string, command: string) => line.replace(/^(?:pick|p)\b/, command);
	if (operation === 'drop') {
		for (const position of positions) lines[position] = retag(lines[position], 'drop');
		return lines.join('\n');
	}
	const [first, ...rest] = positions;
	const moved = rest.map((position) => retag(lines[position], operation));
	const kept = lines.filter((_, i) => !rest.includes(i));
	kept.splice(kept.indexOf(lines[first]) + 1, 0, ...moved);
	return kept.join('\n');
}

/**
 * Checks a squash / fixup / drop before starting it: the commits must be on
 * the current branch, `base` must be the oldest one's parent, and the range
 * must hold no merges — a plain interactive rebase would flatten them.
 * Resolves to an error message, or null when the rewrite is safe to start.
 */
export async function checkRewrite(git: GitExecutor, repo: string, action: Extract<GitAction, { kind: 'rewriteCommits' }>): Promise<string | null> {
	const parents = ((await git.runOrNull(repo, ['rev-list', '--parents', '-n1', action.commits[0]])) ?? '').trim().split(' ').slice(1);
	if ((parents[0] ?? null) !== action.base) return 'The commits changed since the graph was loaded; refresh and try again.';
	for (const commit of action.commits) {
		if ((await git.runOrNull(repo, ['merge-base', '--is-ancestor', commit, 'HEAD'])) === null) {
			return `${commit.slice(0, 8)} is not on the current branch. Only commits of the checked-out branch can be rewritten.`;
		}
	}
	const merges = await git.run(repo, ['rev-list', '--merges', action.base === null ? 'HEAD' : `${action.base}..HEAD`]);
	if (merges.trim() !== '') return 'The commits to rewrite have merge commits after them; rewriting would flatten those merges.';
	return null;
}

/**
 * True when a failure looks like git needed credentials it could not ask for.
 * Prompts are disabled (a hidden prompt would hang forever), so the view
 * offers to run the same command in a terminal, where they can be answered.
 */
export function isCredentialFailure(stderr: string): boolean {
	return /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey|Host key verification failed|passphrase/i.test(stderr);
}

/**
 * The shell a command line is quoted for. Windows has two that quote
 * incompatibly — single quotes are quoting in PowerShell but literal
 * characters in cmd.exe — so the flavour has to be known, not assumed.
 */
export type ShellFlavour = 'posix' | 'powershell' | 'cmd';

/** Characters no shell treats specially, so such an argument needs no quotes. */
const BARE = /^[\w@%+=:,./-]+$/;

const QUOTE: Record<ShellFlavour, (arg: string) => string> = {
	// '…' is literal in every POSIX shell; an embedded quote is closed,
	// escaped and reopened, because nothing escapes inside single quotes.
	posix: (arg) => (BARE.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`),
	// PowerShell's '…' is literal too, and doubles an embedded quote.
	powershell: (arg) => (BARE.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`),
	// cmd.exe hands the line to the program, which parses it by the C runtime
	// rules: "…" groups, \" is a literal quote, and a run of backslashes is
	// doubled where it precedes one.
	cmd: (arg) => (BARE.test(arg) ? arg : `"${arg.replace(/(\\*)("|$)/g, (_, slashes: string, quote: string) => slashes + slashes + (quote === '"' ? '\\"' : ''))}"`)
};

/**
 * Decides which shell a terminal will run, from an executable path or from
 * the name of a VS Code terminal profile ("Command Prompt", "Git Bash"). An
 * empty value means VS Code chooses: PowerShell on Windows, the login shell
 * everywhere else.
 */
export function shellFlavour(shell: string, platform: string): ShellFlavour {
	const name = shell.toLowerCase().replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/, '').trim() ?? '';
	if (name === '') return platform === 'win32' ? 'powershell' : 'posix';
	if (name === 'cmd' || name === 'command prompt') return 'cmd';
	if (name === 'pwsh' || name.includes('powershell')) return 'powershell';
	// bash, sh, zsh, fish, "Git Bash", and every WSL distribution.
	return 'posix';
}

/** Quotes a command line for "Run in Terminal", for the shell that will run it. */
export function shellCommand(binary: string, args: readonly string[], flavour: ShellFlavour): string {
	const quote = QUOTE[flavour];
	const exe = quote(binary);
	// PowerShell reads a quoted string as a value, not a command to run; the
	// call operator runs it. The other two run a quoted path as it stands.
	const prefix = flavour === 'powershell' && exe !== binary ? '& ' : '';
	return `${prefix}${exe} ${args.map(quote).join(' ')}`;
}
