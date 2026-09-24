import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitExecutor } from '../src/git/executor.ts';
import { externalGitDirectories, ignoredPaths, normaliseRepoPath } from '../src/git/repository.ts';
import { gitEnv, realPath } from './support.ts';

let root: string;
let git: GitExecutor;

function sh(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() }).trim();
}

function initRepo(path: string): string {
	mkdirSync(path, { recursive: true });
	sh(path, 'init', '-q', '-b', 'main');
	for (const [key, value] of [['user.email', 't@e'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) sh(path, 'config', key, value);
	writeFileSync(join(path, 'a.txt'), 'a\n');
	sh(path, 'add', '-A');
	sh(path, 'commit', '-q', '-m', 'first');
	return path;
}

const same = (a: string, b: string) => assert.equal(normaliseRepoPath(a), normaliseRepoPath(b));

before(async () => {
	root = realPath(mkdtempSync(join(tmpdir(), 'ggn-watch-')));
	git = await GitExecutor.locate(['git']);
});

after(() => rmSync(root, { recursive: true, force: true }));

test('an ordinary repository keeps everything inside its working tree', async () => {
	const repo = initRepo(join(root, 'plain'));
	assert.equal(await externalGitDirectories(git, repo), null, 'the working tree watcher already sees .git');
});

test('a linked worktree keeps HEAD, its index and its refs outside the working tree', async () => {
	const main = initRepo(join(root, 'main'));
	const worktree = join(root, 'feature-tree');
	sh(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);

	const dirs = await externalGitDirectories(git, worktree);
	assert.ok(dirs !== null, 'a commit here changes nothing inside the working tree');
	same(dirs.gitDir, join(main, '.git', 'worktrees', 'feature-tree'));
	same(dirs.commonDir, join(main, '.git'));

	// The main working tree is an ordinary one, even with worktrees attached.
	assert.equal(await externalGitDirectories(git, main), null);
});

test('a repository with a separate git directory, as submodules have, is followed there', async () => {
	const store = join(root, 'store.git');
	const work = join(root, 'separate');
	mkdirSync(work, { recursive: true });
	sh(work, 'init', '-q', '-b', 'main', `--separate-git-dir=${store}`);

	const dirs = await externalGitDirectories(git, work);
	assert.ok(dirs !== null);
	same(dirs.gitDir, store);
	same(dirs.commonDir, store);
});

test('tells ignored paths from the ones that matter, tracked files included', async () => {
	const repo = initRepo(join(root, 'ignores'));
	writeFileSync(join(repo, '.gitignore'), 'dist/\n*.log\ntracked.log\n');
	mkdirSync(join(repo, 'dist'));
	writeFileSync(join(repo, 'dist', 'bundle.js'), '');
	writeFileSync(join(repo, 'debug.log'), '');
	// A file committed before a pattern covered it is tracked, so it matters.
	writeFileSync(join(repo, 'tracked.log'), '');
	sh(repo, 'add', '-f', 'tracked.log', '.gitignore');
	sh(repo, 'commit', '-q', '-m', 'track');

	const ignored = await ignoredPaths(git, repo, ['dist/bundle.js', 'debug.log', 'a.txt', 'tracked.log', 'src/new file.ts']);
	assert.deepEqual([...ignored].sort(), ['debug.log', 'dist/bundle.js']);
	assert.deepEqual([...(await ignoredPaths(git, repo, ['a.txt']))], [], 'nothing ignored is an answer, not a failure');
	assert.deepEqual([...(await ignoredPaths(git, repo, []))], []);
});
