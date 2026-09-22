import { strict as assert } from 'node:assert';
import { after, before, beforeEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { buildSync } from 'esbuild';
import { GitExecutor } from '../src/git/executor.ts';
import { checkRewrite, planAction, rewriteTodo, validateAction } from '../src/git/actions.ts';
import { EditorBridge } from '../src/git/editorBridge.ts';
import { applyPatches, commitPatch, patchFileName, uncommittedPatch } from '../src/git/patches.ts';
import { GitRefReader } from '../src/git/refs.ts';
import { PendingOperation, type GitAction } from '../src/types.ts';

let root: string;
let repo: string;
let git: GitExecutor;
let bridge: EditorBridge;
/** What the fake editor does with the next file: returns false to cancel. */
let onEdit: (file: string) => boolean = () => true;
const edited: string[] = [];
const options = { signCommits: false, signTags: false };
const env = { ...process.env, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
const subjects = () => sh('log', '--format=%s').split('\n');

function commit(file: string, content: string, message: string): string {
	writeFileSync(join(repo, file), content);
	sh('add', '-A');
	sh('commit', '-q', '-m', message);
	return sh('rev-parse', 'HEAD');
}

async function run(action: GitAction): Promise<void> {
	validateAction(action);
	for (const command of planAction(action, options)) {
		await git.run(repo, command.args, { env: { GIT_CONFIG_GLOBAL: '/dev/null', ...(command.editor === true ? bridge.environment() : {}) } });
	}
}

before(async () => {
	git = await GitExecutor.locate(['git']);
	root = mkdtempSync(join(tmpdir(), 'ggn-rebase-'));
	// The real editor script, built the way the extension ships it.
	const script = join(root, 'editor.js');
	buildSync({ entryPoints: ['src/editor/client.ts'], outfile: script, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
	bridge = await EditorBridge.start(script, process.execPath, async (file) => {
		edited.push(basename(file));
		return onEdit(file);
	});
});

after(() => {
	bridge.dispose();
	rmSync(root, { recursive: true, force: true });
});

const hashes: string[] = [];
beforeEach(() => {
	repo = mkdtempSync(join(root, 'repo-'));
	sh('init', '-q', '-b', 'main');
	for (const [k, v] of [['user.email', 't@e'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) sh('config', k, v);
	hashes.length = 0;
	for (let i = 1; i <= 4; i++) hashes.push(commit(`f${i}.txt`, `${i}\n`, `c${i}`));
	onEdit = () => true;
	edited.length = 0;
});

test('rewrites git’s todo list: squash moves later commits up, drop retags, other lines stay', () => {
	const todo = 'pick 1111111 # c2\npick 2222222 # c3\npick 3333333 # c4\n\n# Rebase … (3 commands)\n';
	assert.equal(
		rewriteTodo(todo, ['1111111aaaa', '3333333bbbb'], 'squash'),
		'pick 1111111 # c2\nsquash 3333333 # c4\npick 2222222 # c3\n\n# Rebase … (3 commands)\n'
	);
	assert.equal(rewriteTodo(todo, ['2222222cccc'], 'drop'), 'pick 1111111 # c2\ndrop 2222222 # c3\npick 3333333 # c4\n\n# Rebase … (3 commands)\n');
	assert.throws(() => rewriteTodo(todo, ['9999999'], 'drop'), /not in the rebase list/);
});

test('squashes chosen commits through git’s editor, with the message edited too', async () => {
	onEdit = (file) => {
		const name = basename(file);
		if (name === 'git-rebase-todo') writeFileSync(file, rewriteTodo(readFileSync(file, 'utf8'), [hashes[1], hashes[3]], 'squash'));
		else writeFileSync(file, 'c2 and c4 together\n');
		return true;
	};
	const action: GitAction = { kind: 'rewriteCommits', commits: [hashes[1], hashes[3]], base: hashes[0], operation: 'squash', review: false };
	assert.equal(await checkRewrite(git, repo, action as Extract<GitAction, { kind: 'rewriteCommits' }>), null);
	await run(action);
	assert.deepEqual(subjects(), ['c3', 'c2 and c4 together', 'c1']);
	assert.deepEqual(edited, ['git-rebase-todo', 'COMMIT_EDITMSG'], 'both editors went through the bridge');
	assert.equal(readFileSync(join(repo, 'f4.txt'), 'utf8'), '4\n', 'no change is lost');
});

test('drops a commit, and cancelling the editor leaves history untouched', async () => {
	onEdit = (file) => {
		writeFileSync(file, rewriteTodo(readFileSync(file, 'utf8'), [hashes[2]], 'drop'));
		return true;
	};
	await run({ kind: 'rewriteCommits', commits: [hashes[2]], base: hashes[1], operation: 'drop', review: false });
	assert.deepEqual(subjects(), ['c4', 'c2', 'c1']);

	const before = sh('rev-parse', 'HEAD');
	onEdit = () => false;
	await assert.rejects(run({ kind: 'rebase', onto: hashes[0], interactive: true, autosquash: false }), /problem with the editor/);
	assert.equal(sh('rev-parse', 'HEAD'), before);
	assert.equal((await new GitRefReader(git, repo).readState()).pendingOperation, null, 'no rebase left behind');
});

test('refuses rewrites off the current branch, over merges, or with a stale base', async () => {
	sh('checkout', '-q', '-b', 'side', hashes[1]);
	const side = commit('s.txt', 's\n', 'side');
	sh('checkout', '-q', 'main');
	const rewrite = (commits: string[], base: string | null): Extract<GitAction, { kind: 'rewriteCommits' }> =>
		({ kind: 'rewriteCommits', commits, base, operation: 'drop', review: false });

	assert.match((await checkRewrite(git, repo, rewrite([side], hashes[1])))!, /not on the current branch/);
	assert.match((await checkRewrite(git, repo, rewrite([hashes[2]], hashes[0])))!, /changed since/);
	sh('merge', '-q', '--no-ff', '-m', 'merge side', 'side');
	assert.match((await checkRewrite(git, repo, rewrite([hashes[2]], hashes[1])))!, /merge commits/);
});

test('creates a fixup commit and autosquashes it without opening an editor', async () => {
	writeFileSync(join(repo, 'f2.txt'), '2 fixed\n');
	await run({ kind: 'commitFixup', target: hashes[1], mode: 'fixup', all: true });
	assert.equal(subjects()[0], 'fixup! c2');

	await run({ kind: 'rebase', onto: hashes[0], interactive: false, autosquash: true });
	assert.deepEqual(subjects(), ['c4', 'c3', 'c2', 'c1']);
	assert.equal(sh('show', 'HEAD~2:f2.txt'), '2 fixed', 'the fix is folded into c2');
	assert.deepEqual(edited, [], 'no editor was needed');
});

test('cherry-picks and reverts several commits, and deletes several branches', async () => {
	sh('checkout', '-q', '-b', 'target', hashes[0]);
	await run({ kind: 'cherryPickMany', hashes: [hashes[1], hashes[3]], recordOrigin: false, noCommit: false });
	assert.deepEqual(subjects(), ['c4', 'c2', 'c1']);
	await run({ kind: 'revertMany', hashes: [sh('rev-parse', 'HEAD'), sh('rev-parse', 'HEAD~1')] });
	assert.deepEqual(subjects().slice(0, 2), ['Revert "c2"', 'Revert "c4"']);

	sh('checkout', '-q', 'main');
	sh('branch', 'merged-a', hashes[1]);
	sh('branch', 'merged-b', hashes[2]);
	await run({ kind: 'deleteBranches', names: ['merged-a', 'merged-b'], force: false });
	await assert.rejects(run({ kind: 'deleteBranches', names: ['target'], force: false }), /not fully merged/);
	await run({ kind: 'deleteBranches', names: ['target'], force: true });
	assert.equal(sh('branch', '--format=%(refname:short)'), 'main');
});

test('creates patches and applies them as commits or to the working tree', async () => {
	assert.equal(patchFileName(3, 'Fix: the (big) bug!'), '0003-Fix-the-big-bug.patch');
	const patch = join(root, 'c4.patch');
	writeFileSync(patch, await commitPatch(git, repo, hashes[3]));

	sh('checkout', '-q', '-b', 'elsewhere', hashes[1]);
	await applyPatches(git, repo, [patch], 'am', false);
	assert.equal(subjects()[0], 'c4', 'git am recreates the commit');

	writeFileSync(join(repo, 'f1.txt'), 'changed\n');
	const diff = join(root, 'wip.patch');
	writeFileSync(diff, await uncommittedPatch(git, repo));
	sh('checkout', '-q', '--', 'f1.txt');
	await applyPatches(git, repo, [diff], 'apply', false);
	assert.equal(readFileSync(join(repo, 'f1.txt'), 'utf8'), 'changed\n');
});

test('an interrupted git am is recognised, and can be aborted', async () => {
	const patch = join(root, 'c4-conflict.patch');
	writeFileSync(patch, await commitPatch(git, repo, hashes[3]));
	writeFileSync(join(repo, 'f4.txt'), 'different\n');
	sh('commit', '-q', '-am', 'clash');
	await assert.rejects(applyPatches(git, repo, [patch], 'am', false));
	assert.equal((await new GitRefReader(git, repo).readState()).pendingOperation, PendingOperation.Am);
	await run({ kind: 'abortOperation', operation: PendingOperation.Am });
	assert.equal((await new GitRefReader(git, repo).readState()).pendingOperation, null);
});
