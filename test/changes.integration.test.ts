import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitExecutor } from '../src/git/executor.ts';
import { emptySideContent, parseNameStatus, parseNumstat, readBlobAtRevision, readChanges } from '../src/git/changes.ts';
import { STAGED, UNCOMMITTED } from '../src/types.ts';
import { gitEnv } from './support.ts';

let repo: string;
let git: GitExecutor;
const hashes: Record<string, string> = {};

function fixture(...args: string[]): string {
	return execFileSync('git', args, {
		cwd: repo,
		encoding: 'utf8',
		env: gitEnv()
	});
}

function commit(message: string): string {
	fixture('add', '-A');
	fixture('commit', '-q', '-m', message);
	return fixture('rev-parse', 'HEAD').trim();
}

before(async () => {
	repo = mkdtempSync(join(tmpdir(), 'ggn-changes-'));
	fixture('init', '-q', '-b', 'main');
	fixture('config', 'user.email', 'test@example.com');
	fixture('config', 'user.name', 'Test');
	fixture('config', 'commit.gpgsign', 'false');
	fixture('config', 'core.autocrlf', 'false');
	// Hostile config: coloured output must not leak escape codes into paths.
	fixture('config', 'color.ui', 'always');

	writeFileSync(join(repo, 'keep.txt'), 'line 1\nline 2\nline 3\nline 4\nline 5\n');
	writeFileSync(join(repo, 'gone.txt'), 'bye\n');
	writeFileSync(join(repo, 'файл с интервал.txt'), 'кирилица\n');
	hashes.root = commit('root');

	writeFileSync(join(repo, 'keep.txt'), 'line 1\nline 2 changed\nline 3\nline 4\nline 5\n');
	fixture('mv', 'файл с интервал.txt', 'преименуван.txt');
	fixture('rm', '-q', 'gone.txt');
	writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
	hashes.second = commit('second');

	git = await GitExecutor.locate(['git']);
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('parses name-status output including renames', () => {
	const parsed = parseNameStatus('M\0a.txt\0R087\0old name.txt\0new name.txt\0D\0x\0');
	assert.deepEqual(parsed, [
		{ type: 'M', path: 'a.txt', oldPath: null },
		{ type: 'R', path: 'new name.txt', oldPath: 'old name.txt' },
		{ type: 'D', path: 'x', oldPath: null }
	]);
});

test('parses numstat output including renames and binary files', () => {
	const parsed = parseNumstat('1\t2\ta.txt\0' + '3\t0\t\0old.txt\0new.txt\0' + '-\t-\tbin.dat\0');
	assert.deepEqual(parsed.get('a.txt'), { additions: 1, deletions: 2 });
	assert.deepEqual(parsed.get('new.txt'), { additions: 3, deletions: 0 });
	assert.deepEqual(parsed.get('bin.dat'), { additions: null, deletions: null });
});

test('lists the files a root commit added', async () => {
	const changes = await readChanges(git, { repo, hash: hashes.root, base: null });
	assert.deepEqual(changes.map((c) => [c.type, c.path]), [['A', 'gone.txt'], ['A', 'keep.txt'], ['A', 'файл с интервал.txt']]);
	assert.equal(changes.find((c) => c.path === 'keep.txt')?.additions, 5);
});

test('lists modifications, deletions, renames and binaries against the parent', async () => {
	const changes = await readChanges(git, { repo, hash: hashes.second, base: hashes.root });
	const byPath = new Map(changes.map((c) => [c.path, c]));

	assert.equal(byPath.get('keep.txt')?.type, 'M');
	assert.deepEqual([byPath.get('keep.txt')?.additions, byPath.get('keep.txt')?.deletions], [1, 1]);
	assert.equal(byPath.get('gone.txt')?.type, 'D');
	assert.equal(byPath.get('преименуван.txt')?.type, 'R');
	assert.equal(byPath.get('преименуван.txt')?.oldPath, 'файл с интервал.txt', 'non-ASCII paths are not quoted or escaped');
	assert.equal(byPath.get('bin.dat')?.additions, null, 'binary files have no line counts');
});

test('lists uncommitted changes including untracked files', async () => {
	writeFileSync(join(repo, 'keep.txt'), 'dirty\n');
	writeFileSync(join(repo, 'new.txt'), 'untracked\n');
	try {
		const changes = await readChanges(git, { repo, hash: UNCOMMITTED, base: hashes.second });
		assert.deepEqual(changes.map((c) => [c.type, c.path]), [['M', 'keep.txt'], ['U', 'new.txt']]);
		const withoutUntracked = await readChanges(git, { repo, hash: UNCOMMITTED, base: hashes.second }, false);
		assert.deepEqual(withoutUntracked.map((c) => c.path), ['keep.txt']);
	} finally {
		fixture('checkout', '-q', '--', 'keep.txt');
		rmSync(join(repo, 'new.txt'));
	}
});

test('reads a file at a revision as bytes, and null when it does not exist there', async () => {
	assert.equal((await readBlobAtRevision(git, repo, hashes.root, 'gone.txt'))?.toString(), 'bye\n');
	assert.equal(await readBlobAtRevision(git, repo, hashes.second, 'gone.txt'), null);
	assert.deepEqual([...(await readBlobAtRevision(git, repo, hashes.second, 'bin.dat'))!], [0, 1, 2, 3, 0, 255], 'binary content is byte-exact');
});

test('the empty side of a notebook diff is still a valid notebook', () => {
	assert.equal(emptySideContent('a.txt'), '');
	const notebook = JSON.parse(emptySideContent('dir/Analysis.IPYNB'));
	assert.deepEqual(notebook.cells, []);
	assert.equal(notebook.nbformat, 4);
});

test('reads the index side of a staged file', async () => {
	// With staged and unstaged changes as separate rows (#575), one side of
	// their diffs is the index. It used to be asked for as `++++…:path`, which
	// git rejects, so that side always came up empty.
	writeFileSync(join(repo, 'keep.txt'), 'staged\n');
	fixture('add', 'keep.txt');
	writeFileSync(join(repo, 'keep.txt'), 'working\n');
	try {
		assert.equal((await readBlobAtRevision(git, repo, STAGED, 'keep.txt'))?.toString('utf8'), 'staged\n');
		assert.match((await readBlobAtRevision(git, repo, hashes.second, 'keep.txt'))?.toString('utf8') ?? '', /line 2 changed/);
	} finally {
		fixture('reset', '-q', '--hard');
	}
});
