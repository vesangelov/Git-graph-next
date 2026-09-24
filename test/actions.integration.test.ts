import { strict as assert } from 'node:assert';
import { after, before, beforeEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitExecutor } from '../src/git/executor.ts';
import { checkRefNames, InvalidActionError, isCredentialFailure, planAction, shellCommand, shellFlavour, validateAction } from '../src/git/actions.ts';
import { GitRefReader } from '../src/git/refs.ts';
import { PendingOperation, type GitAction } from '../src/types.ts';
import { gitEnv, gitRunEnv } from './support.ts';

let root: string;
let repo: string;
let origin: string;
let git: GitExecutor;
const options = { signCommits: false, signTags: false, forceIfIncludes: false };
const env = gitEnv();

function sh(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
}

function commit(file: string, content: string, message: string): string {
	writeFileSync(join(repo, file), content);
	sh(repo, 'add', '-A');
	sh(repo, 'commit', '-q', '-m', message);
	return sh(repo, 'rev-parse', 'HEAD');
}

/** Validates and runs an action the way the host does, throwing git's error. */
async function run(action: GitAction): Promise<void> {
	validateAction(action);
	const invalid = await checkRefNames(git, repo, action);
	if (invalid !== null) throw new Error(invalid);
	for (const command of planAction(action, options)) await git.run(repo, command.args, { env: gitRunEnv() });
}

const head = () => sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
const branches = () => sh(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);

before(async () => {
	git = await GitExecutor.locate(['git']);
});

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'ggn-actions-'));
	origin = join(root, 'origin.git');
	repo = join(root, 'work');
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env });
	execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
	for (const [k, v] of [['user.email', 't@e'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'], ['core.autocrlf', 'false']]) sh(repo, 'config', k, v);
	sh(repo, 'remote', 'add', 'origin', origin);
	commit('a.txt', '1\n', 'one');
	commit('a.txt', '2\n', 'two');
	sh(repo, 'push', '-q', '-u', 'origin', 'main');
});

after(() => rmSync(root, { recursive: true, force: true }));

test('rejects values that git would read as options, and malformed hashes', () => {
	assert.throws(() => validateAction({ kind: 'checkout', branch: '--upload-pack=touch /tmp/pwned' }), InvalidActionError);
	assert.throws(() => validateAction({ kind: 'merge', ref: '-X', noFastForward: false, squash: false, noCommit: false }), InvalidActionError);
	assert.throws(() => validateAction({ kind: 'reset', hash: 'HEAD~1', mode: 'hard' }), InvalidActionError);
	assert.throws(() => validateAction({ kind: 'stashDrop', selector: 'stash@{0} --all' }), InvalidActionError);
	assert.throws(() => validateAction({ kind: 'fetch', remote: 'origin\nrm', prune: false, pruneTags: false, noTags: false }), InvalidActionError);
	assert.throws(() => validateAction({ kind: 'nope' } as unknown as GitAction), InvalidActionError);

	// Full ids of both hash formats pass; anything in between does not.
	assert.doesNotThrow(() => validateAction({ kind: 'checkoutDetached', hash: 'a'.repeat(40) }));
	assert.doesNotThrow(() => validateAction({ kind: 'checkoutDetached', hash: 'a'.repeat(64) }));
	assert.throws(() => validateAction({ kind: 'checkoutDetached', hash: 'a'.repeat(52) }), InvalidActionError);
	assert.throws(() => validateAction({ kind: 'checkoutDetached', hash: 'A'.repeat(64) }), InvalidActionError);
});

test('checks new names with git, before anything runs', async () => {
	const main = sh(repo, 'rev-parse', 'HEAD');
	await assert.rejects(run({ kind: 'createBranch', name: 'bad..name', startPoint: main, checkout: false, force: false }), /not a valid branch name/);
	await assert.rejects(run({ kind: 'createTag', name: 'v1 beta', target: main, message: null, force: false, pushTo: null }), /not a valid tag name/);
	assert.deepEqual(branches(), ['main']);
});

test('creates, checks out, renames and deletes branches', async () => {
	const first = sh(repo, 'rev-parse', 'HEAD~1');
	await run({ kind: 'createBranch', name: 'feature', startPoint: first, checkout: false, force: false });
	assert.equal(sh(repo, 'rev-parse', 'feature'), first);
	assert.equal(head(), 'main', 'not checked out unless asked');

	// A branch named like a file must still check out as a branch.
	await run({ kind: 'createBranch', name: 'a.txt', startPoint: first, checkout: true, force: false });
	assert.equal(head(), 'a.txt');
	await run({ kind: 'checkout', branch: 'main' });
	await run({ kind: 'renameBranch', from: 'a.txt', to: 'renamed' });
	assert.deepEqual(branches().sort(), ['feature', 'main', 'renamed']);

	await run({ kind: 'deleteBranch', name: 'renamed', force: false, deleteOnRemote: null });
	assert.deepEqual(branches().sort(), ['feature', 'main']);
});

test('refuses to delete an unmerged branch unless forced', async () => {
	await run({ kind: 'createBranch', name: 'wip', startPoint: sh(repo, 'rev-parse', 'HEAD'), checkout: true, force: false });
	commit('b.txt', 'x\n', 'unmerged work');
	await run({ kind: 'checkout', branch: 'main' });
	await assert.rejects(run({ kind: 'deleteBranch', name: 'wip', force: false, deleteOnRemote: null }), /not fully merged/);
	await run({ kind: 'deleteBranch', name: 'wip', force: true, deleteOnRemote: null });
	assert.deepEqual(branches(), ['main']);
});

test('checks out a commit detached, and a remote branch as a tracking branch', async () => {
	const first = sh(repo, 'rev-parse', 'HEAD~1');
	await run({ kind: 'checkoutDetached', hash: first });
	assert.equal(head(), 'HEAD');
	assert.equal(sh(repo, 'rev-parse', 'HEAD'), first);

	sh(repo, 'push', '-q', 'origin', `${first}:refs/heads/topic`);
	sh(repo, 'fetch', '-q', 'origin');
	await run({ kind: 'checkoutRemote', remoteBranch: 'origin/topic', localName: 'topic' });
	assert.equal(head(), 'topic');
	assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'origin/topic');
});

test('creates lightweight and annotated tags, pushes and deletes them locally and remotely', async () => {
	const main = sh(repo, 'rev-parse', 'HEAD');
	await run({ kind: 'createTag', name: 'light', target: main, message: null, force: false, pushTo: null });
	await run({ kind: 'createTag', name: 'v1.0', target: main, message: 'Release\n\nwith "notes" $(x)', force: false, pushTo: 'origin' });
	assert.equal(sh(repo, 'cat-file', '-t', 'v1.0'), 'tag');
	assert.equal(sh(repo, 'cat-file', '-t', 'light'), 'commit');
	assert.match(sh(repo, 'tag', '-l', '--format=%(contents)', 'v1.0'), /with "notes" \$\(x\)/);
	assert.equal(sh(origin, 'tag', '-l'), 'v1.0', 'pushed to the remote');

	await run({ kind: 'pushTag', name: 'light', remote: 'origin', force: false });
	await run({ kind: 'deleteTag', name: 'v1.0', deleteOnRemote: 'origin' });
	assert.equal(sh(repo, 'tag', '-l'), 'light');
	assert.equal(sh(origin, 'tag', '-l'), 'light');
});

test('pushes a new branch with upstream, force-pushes with lease, deletes it remotely', async () => {
	await run({ kind: 'createBranch', name: 'pub', startPoint: sh(repo, 'rev-parse', 'HEAD'), checkout: true, force: false });
	commit('p.txt', '1\n', 'pub work');
	await run({ kind: 'push', branch: 'pub', remote: 'origin', setUpstream: true, force: 'none' });
	assert.equal(sh(repo, 'rev-parse', '--abbrev-ref', 'pub@{upstream}'), 'origin/pub');

	sh(repo, 'commit', '-q', '--amend', '-m', 'rewritten');
	await assert.rejects(run({ kind: 'push', branch: 'pub', remote: 'origin', setUpstream: false, force: 'none' }), /rejected|non-fast-forward/);
	await run({ kind: 'push', branch: 'pub', remote: 'origin', setUpstream: false, force: 'with-lease' });
	assert.equal(sh(origin, 'log', '-1', '--format=%s', 'pub'), 'rewritten');

	await run({ kind: 'checkout', branch: 'main' });
	await run({ kind: 'deleteRemoteBranch', remote: 'origin', branch: 'pub' });
	assert.equal(sh(origin, 'branch', '--list', 'pub'), '');
});

test('a force push with lease refuses to drop work that only a background fetch has seen', async (t) => {
	if (!git.atLeast(2, 30)) return t.skip('--force-if-includes needs git 2.30');
	// A colleague pushes to main…
	const colleague = join(root, 'colleague');
	execFileSync('git', ['clone', '-q', origin, colleague], { env });
	for (const [k, v] of [['user.email', 'c@e'], ['user.name', 'C'], ['commit.gpgsign', 'false']]) sh(colleague, 'config', k, v);
	writeFileSync(join(colleague, 'c.txt'), 'theirs\n');
	sh(colleague, 'add', '-A');
	sh(colleague, 'commit', '-q', '-m', "colleague's work");
	sh(colleague, 'push', '-q', 'origin', 'main');

	// …while here the last commit is rewritten, and a fetch runs in the
	// background (VS Code's autofetch, or the graph's own Fetch). That moves
	// origin/main to the colleague's commit, which is all a bare lease checks.
	sh(repo, 'commit', '-q', '--amend', '-m', 'rewritten here');
	sh(repo, 'fetch', '-q', 'origin');

	const push: GitAction = { kind: 'push', branch: 'main', remote: 'origin', setUpstream: false, force: 'with-lease' };
	const [command] = planAction(push, { ...options, forceIfIncludes: true });
	assert.deepEqual(command.args, ['push', '--force-with-lease', '--force-if-includes', 'origin', 'refs/heads/main:refs/heads/main']);
	await assert.rejects(git.run(repo, command.args, { env: gitRunEnv() }), /rejected|updated since checkout/);
	assert.equal(sh(origin, 'log', '-1', '--format=%s', 'main'), "colleague's work", 'the remote keeps the work nobody here has seen');

	// Without the check, the same push goes through and the work is gone.
	const [bare] = planAction(push, options);
	await git.run(repo, bare.args, { env: gitRunEnv() });
	assert.equal(sh(origin, 'log', '-1', '--format=%s', 'main'), 'rewritten here');
});

test('fetches with prune, and pulls in each mode', async () => {
	// A second clone moves main on the remote.
	const other = join(root, 'other');
	execFileSync('git', ['clone', '-q', origin, other], { env });
	sh(other, 'config', 'user.email', 'o@e');
	sh(other, 'config', 'user.name', 'O');
	writeFileSync(join(other, 'o.txt'), 'o\n');
	sh(other, 'add', '-A');
	sh(other, 'commit', '-q', '-m', 'from other');
	sh(other, 'push', '-q', 'origin', 'main', 'HEAD:refs/heads/doomed');
	sh(repo, 'fetch', '-q', 'origin');
	sh(other, 'push', '-q', 'origin', '--delete', 'doomed');

	await run({ kind: 'fetch', remote: 'origin', prune: true, pruneTags: false, noTags: false });
	assert.equal(sh(repo, 'branch', '-r', '--list', 'origin/doomed'), '', 'pruned');
	await run({ kind: 'fetch', remote: null, prune: false, pruneTags: false, noTags: false });

	await run({ kind: 'pull', mode: 'ff-only' });
	assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'from other');
});

test('merges, cherry-picks, reverts and resets', async () => {
	const base = sh(repo, 'rev-parse', 'HEAD');
	await run({ kind: 'createBranch', name: 'side', startPoint: base, checkout: true, force: false });
	const pick = commit('s.txt', 's\n', 'side work');
	await run({ kind: 'checkout', branch: 'main' });

	await run({ kind: 'merge', ref: 'side', noFastForward: true, squash: false, noCommit: false });
	assert.equal(sh(repo, 'log', '-1', '--format=%P').split(' ').length, 2, 'a merge commit, not a fast-forward');

	await run({ kind: 'reset', hash: base, mode: 'hard' });
	assert.equal(sh(repo, 'rev-parse', 'HEAD'), base);

	await run({ kind: 'cherryPick', hash: pick, mainline: null, noCommit: false, recordOrigin: true });
	assert.match(sh(repo, 'log', '-1', '--format=%B'), /cherry picked from commit/);
	const picked = sh(repo, 'rev-parse', 'HEAD');
	await run({ kind: 'revert', hash: picked, mainline: null });
	assert.match(sh(repo, 'log', '-1', '--format=%s'), /^Revert "side work"$/);
	assert.equal(existsSync(join(repo, 's.txt')), false);

	await run({ kind: 'reset', hash: picked, mode: 'soft' });
	assert.equal(sh(repo, 'rev-parse', 'HEAD'), picked);
	assert.equal(sh(repo, 'status', '--porcelain'), 'D  s.txt', 'soft keeps the revert staged');
});

test('shows an interrupted merge, and aborts or continues it', async () => {
	const base = sh(repo, 'rev-parse', 'HEAD');
	await run({ kind: 'createBranch', name: 'clash', startPoint: base, checkout: true, force: false });
	commit('a.txt', 'theirs\n', 'theirs');
	await run({ kind: 'checkout', branch: 'main' });
	commit('a.txt', 'ours\n', 'ours');

	await assert.rejects(run({ kind: 'merge', ref: 'clash', noFastForward: false, squash: false, noCommit: false }), /conflict/i);
	const state = () => new GitRefReader(git, repo).readState();
	assert.equal((await state()).pendingOperation, PendingOperation.Merge);

	await run({ kind: 'abortOperation', operation: PendingOperation.Merge });
	assert.equal((await state()).pendingOperation, null);

	await assert.rejects(run({ kind: 'merge', ref: 'clash', noFastForward: false, squash: false, noCommit: false }));
	writeFileSync(join(repo, 'a.txt'), 'resolved\n');
	sh(repo, 'add', 'a.txt');
	await run({ kind: 'continueOperation', operation: PendingOperation.Merge });
	assert.equal((await state()).pendingOperation, null);
	assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'resolved\n');
});

test('stashes, applies, pops, drops and branches from stashes', async () => {
	writeFileSync(join(repo, 'a.txt'), 'dirty\n');
	writeFileSync(join(repo, 'new.txt'), 'untracked\n');
	await run({ kind: 'stashPush', message: 'my "work"', includeUntracked: true });
	assert.equal(sh(repo, 'status', '--porcelain'), '');
	assert.match(sh(repo, 'stash', 'list'), /my "work"/);

	await run({ kind: 'stashApply', selector: 'stash@{0}', reinstateIndex: false });
	assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'dirty\n');
	await run({ kind: 'discardChanges' });
	await run({ kind: 'cleanUntracked', directories: true });
	assert.equal(sh(repo, 'status', '--porcelain'), '');

	writeFileSync(join(repo, 'a.txt'), 'dirty again\n');
	await run({ kind: 'stashPush', message: '', includeUntracked: false });
	assert.equal(sh(repo, 'stash', 'list').split('\n').length, 2);
	await run({ kind: 'stashDrop', selector: 'stash@{0}' });
	await run({ kind: 'stashBranch', selector: 'stash@{0}', name: 'from-stash' });
	assert.equal(head(), 'from-stash');
	assert.equal(sh(repo, 'stash', 'list'), '');
});

test('recognises credential failures and quotes commands for a terminal', () => {
	assert.ok(isCredentialFailure('fatal: could not read Username for \'https://github.com\': terminal prompts disabled'));
	assert.ok(isCredentialFailure('git@github.com: Permission denied (publickey).'));
	assert.ok(!isCredentialFailure('error: failed to push some refs'));
	assert.equal(shellCommand('git', ['push', 'origin', "it's here"], 'posix'), `git push origin 'it'\\''s here'`);
	assert.equal(shellCommand('C:\\Program Files\\Git\\bin\\git.exe', ['push', "a'b"], 'powershell'), `& 'C:\\Program Files\\Git\\bin\\git.exe' push 'a''b'`);
});

test('quotes for the shell the terminal actually runs', () => {
	// cmd.exe treats a single quote as an ordinary character, so a PowerShell
	// line pasted into it pushes literal quotes into the branch name.
	assert.equal(shellCommand('C:\\Program Files\\Git\\bin\\git.exe', ['push', 'origin', 'a b'], 'cmd'), `"C:\\Program Files\\Git\\bin\\git.exe" push origin "a b"`);
	// No call operator in cmd, and none in PowerShell for an unquoted name.
	assert.equal(shellCommand('git', ['fetch'], 'cmd'), 'git fetch');
	assert.equal(shellCommand('git', ['fetch'], 'powershell'), 'git fetch');
	// The C runtime reads \" as a literal quote and halves the backslashes
	// before it, so each one written out has to be doubled.
	assert.equal(shellCommand('git', ['push', 'origin', 'a"b'], 'cmd'), 'git push origin "a\\"b"');
	assert.equal(shellCommand('git', ['push', 'origin', 'a\\b c'], 'cmd'), 'git push origin "a\\b c"');
	assert.equal(shellCommand('git', ['push', 'origin', 'ends\\'], 'cmd'), 'git push origin "ends\\\\"');

	// An explicit shell path, a VS Code profile name, and nothing at all.
	assert.equal(shellFlavour('C:\\Windows\\System32\\cmd.exe', 'win32'), 'cmd');
	assert.equal(shellFlavour('Command Prompt', 'win32'), 'cmd');
	assert.equal(shellFlavour('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), 'powershell');
	assert.equal(shellFlavour('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32'), 'powershell');
	assert.equal(shellFlavour('Git Bash', 'win32'), 'posix');
	assert.equal(shellFlavour('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'), 'posix');
	assert.equal(shellFlavour('/bin/zsh', 'darwin'), 'posix');
	assert.equal(shellFlavour('', 'win32'), 'powershell');
	assert.equal(shellFlavour('', 'linux'), 'posix');
});

test('force-pushes a moved tag, and manages remotes and the repository user', async () => {
	const first = sh(repo, 'rev-parse', 'HEAD~1');
	sh(repo, 'tag', 'moving', first);
	await run({ kind: 'pushTag', name: 'moving', remote: 'origin', force: false });
	sh(repo, 'tag', '-f', 'moving', 'HEAD');
	await assert.rejects(run({ kind: 'pushTag', name: 'moving', remote: 'origin', force: false }), /already exists|rejected/);
	await run({ kind: 'pushTag', name: 'moving', remote: 'origin', force: true });
	assert.equal(sh(origin, 'rev-parse', 'moving'), sh(repo, 'rev-parse', 'HEAD'));

	await run({ kind: 'addRemote', name: 'mirror', url: origin, fetch: true });
	assert.equal(sh(repo, 'rev-parse', 'mirror/main'), sh(repo, 'rev-parse', 'origin/main'), 'fetched right away');
	await run({ kind: 'setRemoteUrl', name: 'mirror', url: join(root, 'elsewhere.git') });
	assert.equal(sh(repo, 'remote', 'get-url', 'mirror'), join(root, 'elsewhere.git'));
	await run({ kind: 'removeRemote', name: 'mirror' });
	assert.equal(sh(repo, 'remote'), 'origin');
	await run({ kind: 'fetch', remote: 'origin', prune: false, pruneTags: false, noTags: true });

	await run({ kind: 'setUserConfig', name: 'Иван Петров', email: 'ivan@example.com' });
	assert.equal(sh(repo, 'config', '--local', 'user.name'), 'Иван Петров');
	await run({ kind: 'setUserConfig', name: '', email: '' });
	assert.throws(() => sh(repo, 'config', '--local', 'user.name'), 'an empty field removes the repository’s own value');
	assert.throws(() => validateAction({ kind: 'setUserConfig', name: 'a\nb', email: '' }), InvalidActionError);
});

test('the archive and empty-tree commands work as the host uses them', async () => {
	const zip = await git.runBinary(repo, ['archive', '--format=zip', sh(repo, 'rev-parse', 'HEAD')]);
	assert.equal(zip.subarray(0, 2).toString(), 'PK', 'a zip file');
	const tgz = await git.runBinary(repo, ['archive', '--format=tar.gz', 'HEAD']);
	assert.deepEqual([...tgz.subarray(0, 2)], [0x1f, 0x8b], 'gzip');
	assert.equal((await git.run(repo, ['mktree'], { stdin: '' })).trim(), '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'the empty tree');
});
