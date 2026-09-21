import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitExecutor } from '../src/git/executor.ts';
import { countStatusEntries, insertStashes, loadGraphData, type GraphDataRequest } from '../src/git/graphData.ts';
import { dedupePaths, discoverRepositories, scanForNestedRepositories } from '../src/git/repository.ts';
import { UNCOMMITTED, emptyFilter, type Commit, type Stash } from '../src/types.ts';

let root: string;
let git: GitExecutor;

function fixture(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
	});
}

function initRepo(path: string): string {
	mkdirSync(path, { recursive: true });
	fixture(path, 'init', '-q', '-b', 'main');
	fixture(path, 'config', 'user.email', 'test@example.com');
	fixture(path, 'config', 'user.name', 'Test');
	fixture(path, 'config', 'commit.gpgsign', 'false');
	return path;
}

function commitFile(cwd: string, name: string, content: string, message: string): void {
	writeFileSync(join(cwd, name), content);
	fixture(cwd, 'add', name);
	fixture(cwd, 'commit', '-q', '-m', message);
}

const request: GraphDataRequest = {
	filter: emptyFilter(),
	maxCommits: 100,
	ordering: 'date',
	onlyFollowFirstParent: false,
	includeCommitsMentionedByReflogs: false,
	showUncommittedChanges: true,
	showUntrackedFiles: true,
	followRenames: false
};

before(async () => {
	root = mkdtempSync(join(tmpdir(), 'ggn-data-'));
	git = await GitExecutor.locate(['git']);
});

after(() => {
	rmSync(root, { recursive: true, force: true });
});

test('counts status entries, counting a rename once', () => {
	assert.equal(countStatusEntries(''), 0);
	assert.equal(countStatusEntries(' M a.txt\0?? b.txt\0'), 2);
	// A rename is followed by a second field holding the original path.
	assert.equal(countStatusEntries('R  new.txt\0old.txt\0 M c.txt\0'), 2);
});

test('places a stash above its base, and never below it', () => {
	const make = (hash: string, parents: string[], date: number): Commit => ({
		hash: hash.padEnd(40, '0'), parents: parents.map((p) => p.padEnd(40, '0')), author: '', authorEmail: '',
		authorDate: date, committer: '', committerEmail: '', committerDate: date, subject: hash, body: '', stash: null
	});
	const commits = [make('c', ['b'], 300), make('b', ['a'], 200), make('a', [], 100)];
	const stash = (hash: string, base: string, date: number, index: number): Stash => ({
		index, hash: hash.padEnd(40, '0'), baseHash: base.padEnd(40, '0'), selector: `stash@{${index}}`, message: 'WIP', date
	});

	// Newer than everything: goes to the top.
	let rows = insertStashes(commits, [stash('s', 'b', 400, 0)]);
	assert.deepEqual(rows.map((r) => r.subject[0]), ['W', 'c', 'b', 'a']);
	assert.deepEqual(rows[0].parents, ['b'.padEnd(40, '0')], 'a stash row has only its base as parent');

	// Dated before its own base (clock skew): pinned directly above the base.
	rows = insertStashes(commits, [stash('s', 'b', 50, 0)]);
	assert.deepEqual(rows.map((r) => r.subject[0]), ['c', 'W', 'b', 'a']);

	// Base not loaded: the stash is left out rather than floating unattached.
	rows = insertStashes(commits, [stash('s', 'z', 400, 0)]);
	assert.equal(rows.length, 3);
});

test('loads commits, refs, stashes and the uncommitted row together', async () => {
	const repo = initRepo(join(root, 'full'));
	commitFile(repo, 'a.txt', 'a\n', 'first');
	commitFile(repo, 'a.txt', 'b\n', 'second');
	writeFileSync(join(repo, 'a.txt'), 'stashed\n');
	fixture(repo, 'stash', 'push', '-q', '-m', 'my stash');
	fixture(repo, 'tag', 'v1');
	writeFileSync(join(repo, 'a.txt'), 'dirty\n');
	writeFileSync(join(repo, 'new.txt'), 'untracked\n');

	const data = await loadGraphData(git, repo, request);

	assert.equal(data.commits[0].hash, UNCOMMITTED);
	assert.equal(data.commits[0].subject, 'Uncommitted Changes (2)');
	assert.equal(data.commits[0].parents[0], data.repo.headHash, 'the uncommitted row hangs off HEAD');

	const stashRows = data.commits.filter((c) => c.stash !== null);
	assert.equal(stashRows.length, 1);
	assert.match(stashRows[0].subject, /my stash/);
	assert.equal(data.commits.filter((c) => c.subject === 'second').length, 1);
	assert.ok(!data.commits.some((c) => /^index on/.test(c.subject)), "a stash's internal index commit must not be drawn");

	assert.equal(data.repo.head, 'main');
	assert.deepEqual(data.heads.map((h) => h.name), ['main']);
	assert.deepEqual(data.tags.map((t) => t.name), ['v1']);

	const hidden = await loadGraphData(git, repo, { ...request, showUntrackedFiles: false, filter: { ...emptyFilter(), showTags: false } });
	assert.equal(hidden.commits[0].subject, 'Uncommitted Changes (1)', 'untracked files are excluded when asked');
	assert.equal(hidden.tags.length, 0);
});

test('an empty repository loads as an empty graph, not an error', async () => {
	const repo = initRepo(join(root, 'empty'));
	writeFileSync(join(repo, 'x.txt'), 'x\n');
	const data = await loadGraphData(git, repo, request);
	assert.equal(data.commits.length, 0);
	assert.equal(data.repo.headHash, null);
});

test('an orphan branch checked out still shows the other branches', async () => {
	const repo = initRepo(join(root, 'orphan'));
	commitFile(repo, 'a.txt', 'a\n', 'on main');
	fixture(repo, 'checkout', '-q', '--orphan', 'fresh');
	const data = await loadGraphData(git, repo, request);
	assert.deepEqual(data.commits.filter((c) => c.hash !== UNCOMMITTED).map((c) => c.subject), ['on main']);
	assert.equal(data.repo.headHash, null);
});

test('discovers the enclosing repository and nested ones within the depth limit', async () => {
	const outer = initRepo(join(root, 'workspace'));
	initRepo(join(outer, 'libs', 'inner'));
	initRepo(join(outer, 'node_modules', 'dep'));
	mkdirSync(join(outer, 'plain'), { recursive: true });

	const shallow = await discoverRepositories(git, [outer], 1);
	assert.deepEqual(shallow, [outer], 'depth 1 does not reach libs/inner');

	const deep = await discoverRepositories(git, [outer], 2);
	assert.deepEqual(deep, [outer, join(outer, 'libs', 'inner')], 'node_modules is never scanned');

	// Opening a subfolder of a repository finds the repository it belongs to.
	const fromSubfolder = await discoverRepositories(git, [join(outer, 'plain')], 0);
	assert.deepEqual(fromSubfolder, [outer]);

	assert.deepEqual(scanForNestedRepositories(outer, 0), []);
	assert.deepEqual(await discoverRepositories(git, [join(root, 'does-not-exist')], 3), []);
});

test('deduplicates repository paths', () => {
	assert.deepEqual(dedupePaths(['/a/b', '/a/b/', '/a/./b', '/c']), ['/a/b', '/c']);
});

/**
 * main: a1(A) ─ b1(B) ─ a2(A) ─────────── merge(A) ─ rename(A) ─ b5(B)
 *                         └ c2(B) ─ a3f(A) ┘
 * a.txt is renamed to ren.txt in "rename"; a branch is named like a file.
 */
async function filterRepo(): Promise<string> {
	const repo = initRepo(join(root, 'filters'));
	const as = (who: string, file: string, line: string, message: string) => {
		writeFileSync(join(repo, file), line, { flag: 'a' });
		fixture(repo, 'add', '-A');
		fixture(repo, '-c', `user.name=${who}`, '-c', `user.email=${who.toLowerCase()}@x`, 'commit', '-q', '-m', message);
	};
	as('Alice', 'a.txt', '1\n', 'a1');
	as('Bob', 'b.txt', '1\n', 'b1');
	as('Alice', 'a.txt', '2\n', 'a2');
	fixture(repo, 'checkout', '-q', '-b', 'feature');
	as('Bob', 'c.txt', '2\n', 'c2');
	as('Alice', 'a.txt', '3\n', 'a3f');
	fixture(repo, 'checkout', '-q', 'main');
	fixture(repo, '-c', 'user.name=Alice', '-c', 'user.email=alice@x', 'merge', '-q', '--no-ff', 'feature', '-m', 'merge');
	fixture(repo, 'mv', 'a.txt', 'ren.txt');
	as('Alice', 'ren.txt', '4\n', 'rename');
	as('Bob', 'b.txt', '5\n', 'b5');
	fixture(repo, 'branch', 'b.txt');
	return repo;
}

/** Every parent of every row is itself a row: the graph has no dangling edges. */
function assertConnected(commits: readonly Commit[]): void {
	const shown = new Set(commits.map((c) => c.hash));
	for (const commit of commits) {
		for (const parent of commit.parents) assert.ok(shown.has(parent), `${commit.subject} has a parent that is not shown`);
	}
}

test('filters by author and reconnects the graph through hidden commits', async () => {
	const repo = await filterRepo();
	const data = await loadGraphData(git, repo, { ...request, filter: { ...emptyFilter(), authors: ['alice'] } });
	assert.deepEqual(data.commits.map((c) => c.subject), ['rename', 'merge', 'a3f', 'a2', 'a1']);
	assertConnected(data.commits);
	const byName = new Map(data.commits.map((c) => [c.subject, c]));
	assert.deepEqual(byName.get('a2')!.parents, [byName.get('a1')!.hash], 'the hidden b1 is skipped');
	assert.deepEqual(byName.get('a3f')!.parents, [byName.get('a2')!.hash], 'the hidden c2 is skipped');
});

test('matches author names literally, not as regular expressions', async () => {
	const repo = join(root, 'filters');
	const data = await loadGraphData(git, repo, { ...request, filter: { ...emptyFilter(), authors: ['Al.ce'] } });
	assert.equal(data.commits.length, 0);
});

test('filters by path with parents rewritten by git', async () => {
	const repo = join(root, 'filters');
	const data = await loadGraphData(git, repo, { ...request, filter: { ...emptyFilter(), paths: ['b.txt'] } });
	assert.deepEqual(data.commits.map((c) => c.subject), ['b5', 'b1']);
	assertConnected(data.commits);
});

test('follows a single file across a rename', async () => {
	const repo = join(root, 'filters');
	const data = await loadGraphData(git, repo, { ...request, followRenames: true, filter: { ...emptyFilter(), paths: ['ren.txt'] } });
	assert.deepEqual(data.commits.map((c) => c.subject), ['rename', 'a3f', 'a2', 'a1']);
	assertConnected(data.commits);
});

test('filters by branch, including one named like a file', async () => {
	const repo = join(root, 'filters');
	const feature = await loadGraphData(git, repo, { ...request, filter: { ...emptyFilter(), branches: ['refs/heads/feature'] } });
	assert.deepEqual(feature.commits.map((c) => c.subject), ['a3f', 'c2', 'a2', 'b1', 'a1']);

	const fileNamed = await loadGraphData(git, repo, { ...request, filter: { ...emptyFilter(), branches: ['refs/heads/b.txt'] } });
	assert.equal(fileNamed.commits[0].subject, 'b5');
});

test('ignores a filtered branch that no longer exists', async () => {
	const repo = join(root, 'filters');
	const data = await loadGraphData(git, repo, { ...request, filter: { ...emptyFilter(), branches: ['refs/heads/deleted'] } });
	assert.equal(data.commits.length, 8, 'with nothing left to select, every branch is shown');
});

test('excludes branches in every namespace and reports the hidden refs', async () => {
	const repo = initRepo(join(root, 'exclude'));
	commitFile(repo, 'a.txt', '1\n', 'base');
	fixture(repo, 'checkout', '-q', '-b', 'topic');
	commitFile(repo, 't.txt', '1\n', 'topic work');
	fixture(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
	fixture(repo, 'update-ref', 'refs/remotes/origin/topic', 'HEAD');
	fixture(repo, 'tag', 'nightly-1');
	fixture(repo, 'checkout', '-q', 'main');

	const subjects = async (excludeGlobs: string[]) => {
		const data = await loadGraphData(git, repo, { ...request, filter: { ...emptyFilter(), excludeGlobs } });
		return { subjects: data.commits.map((c) => c.subject), excluded: [...data.excludedRefs].sort() };
	};

	// Only the local branch excluded: the remote copy and the tag still reach the commit.
	assert.deepEqual((await subjects(['topic'])).subjects, ['topic work', 'base']);
	assert.deepEqual((await subjects(['topic'])).excluded, ['refs/heads/topic']);

	const all = await subjects(['*topic', 'nightly-*']);
	assert.deepEqual(all.subjects, ['base'], 'patterns apply to remotes and tags too, not just --branches');
	assert.deepEqual(all.excluded, ['refs/heads/topic', 'refs/remotes/origin/topic', 'refs/tags/nightly-1']);
});

test('extra log arguments that drop commits leave a connected graph', async () => {
	const repo = join(root, 'filters');
	const data = await loadGraphData(git, repo, { ...request, filter: { ...emptyFilter(), extraArgs: ['--no-merges'] } });
	assert.ok(!data.commits.some((c) => c.subject === 'merge'));
	assert.equal(data.commits.length, 7);
	assertConnected(data.commits);
});
