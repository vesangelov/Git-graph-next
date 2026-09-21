import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitExecutor } from '../src/git/executor.ts';
import { GitLogReader } from '../src/git/log.ts';
import { GitRefReader } from '../src/git/refs.ts';
import { PendingOperation } from '../src/types.ts';

let repo: string;
let git: GitExecutor;

/** Runs git directly, bypassing the layer under test, to build fixtures. */
function fixture(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
	});
}

function commitFile(cwd: string, name: string, content: string, message: string): void {
	writeFileSync(join(cwd, name), content);
	fixture(cwd, 'add', name);
	fixture(cwd, '-c', 'commit.gpgsign=false', 'commit', '-m', message);
}

before(async () => {
	repo = mkdtempSync(join(tmpdir(), 'ggn-test-'));
	fixture(repo, 'init', '-q', '-b', 'main');
	fixture(repo, 'config', 'user.email', 'test@example.com');
	fixture(repo, 'config', 'user.name', 'Тест Потребител');

	commitFile(repo, 'a.txt', 'a\n', 'първи комит с кирилица 🎉');
	commitFile(repo, 'a.txt', 'ab\n', 'subject line\n\nA body with a blank line.\n\nAnd a "quoted" $(thing) | pipe.');
	fixture(repo, 'checkout', '-q', '-b', 'feature');
	commitFile(repo, 'c.txt', 'c\n', 'work on the feature');
	fixture(repo, 'checkout', '-q', 'main');
	commitFile(repo, 'd.txt', 'd\n', 'main moves on');
	fixture(repo, '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', 'feature', '-m', 'merge feature');
	fixture(repo, 'tag', '-a', 'v1.0', '-m', 'release one');
	fixture(repo, 'tag', 'lightweight');

	git = await GitExecutor.locate(['git']);
});

after(() => {
	rmSync(repo, { recursive: true, force: true });
});

test('locates a usable git binary and reports its version', () => {
	assert.ok(git.version.major >= 2, `unexpected git version ${git.version.raw}`);
	assert.equal(git.atLeast(2, 0), true);
	assert.equal(git.atLeast(99, 0), false);
});

test('reports a clear error when no git binary can be found', async () => {
	await assert.rejects(
		() => GitExecutor.locate(['/nonexistent/git-binary']),
		(error: Error) => {
			assert.match(error.message, /could not find a usable git executable/);
			assert.match(error.message, /git-graph-next\.git\.path/, 'the message must say how to fix it');
			return true;
		}
	);
});

test('reads every commit with its parents in order', async () => {
	const reader = new GitLogReader(git, repo);
	const result = await reader.read({
		filter: {
			paths: [], authors: [], branches: [], excludeGlobs: [],
			showRemoteBranches: true, showTags: true, grep: null, since: null, until: null, extraArgs: []
		},
		maxCommits: 100,
		ordering: 'date',
		onlyFollowFirstParent: false,
		includeCommitsMentionedByReflogs: false,
		followRenames: false,
		includeStashes: false
	});

	assert.equal(result.commits.length, 5);
	assert.equal(result.moreAvailable, false);
	assert.equal(result.commits[0].subject, 'merge feature');
	assert.equal(result.commits[0].parents.length, 2, 'a merge commit keeps both parents');
	assert.equal(result.commits[4].parents.length, 0, 'the root commit has no parents');
	for (const commit of result.commits) {
		assert.match(commit.hash, /^[0-9a-f]{40}$/);
		assert.ok(commit.authorDate > 0, 'author date must be a real timestamp');
	}
});

test('preserves non-ASCII authors and hostile commit messages', async () => {
	const reader = new GitLogReader(git, repo);
	const { commits } = await reader.read({
		filter: {
			paths: [], authors: [], branches: [], excludeGlobs: [],
			showRemoteBranches: true, showTags: true, grep: null, since: null, until: null, extraArgs: []
		},
		maxCommits: 100, ordering: 'date', onlyFollowFirstParent: false,
		includeCommitsMentionedByReflogs: false, followRenames: false, includeStashes: false
	});

	const root = commits[commits.length - 1];
	assert.equal(root.subject, 'първи комит с кирилица 🎉');
	assert.equal(root.author, 'Тест Потребител');

	const bodied = commits.find((c) => c.subject === 'subject line');
	assert.ok(bodied !== undefined, 'the multi-line commit must be present');
	assert.match(bodied.body, /A body with a blank line\./);
	assert.match(bodied.body, /"quoted" \$\(thing\) \| pipe\./, 'shell metacharacters must survive verbatim');
});

test('reports when more commits are available than were requested', async () => {
	const reader = new GitLogReader(git, repo);
	const { commits, moreAvailable } = await reader.read({
		filter: {
			paths: [], authors: [], branches: [], excludeGlobs: [],
			showRemoteBranches: true, showTags: true, grep: null, since: null, until: null, extraArgs: []
		},
		maxCommits: 2, ordering: 'date', onlyFollowFirstParent: false,
		includeCommitsMentionedByReflogs: false, followRenames: false, includeStashes: false
	});

	assert.equal(commits.length, 2, 'exactly the requested number is returned');
	assert.equal(moreAvailable, true);
});

test('filters history to a single path', async () => {
	const reader = new GitLogReader(git, repo);
	const { commits } = await reader.read({
		filter: {
			paths: ['c.txt'], authors: [], branches: [], excludeGlobs: [],
			showRemoteBranches: true, showTags: true, grep: null, since: null, until: null, extraArgs: []
		},
		maxCommits: 100, ordering: 'date', onlyFollowFirstParent: false,
		includeCommitsMentionedByReflogs: false, followRenames: false, includeStashes: false
	});

	assert.equal(commits.length, 1);
	assert.equal(commits[0].subject, 'work on the feature');
});

test('filters history by author', async () => {
	const reader = new GitLogReader(git, repo);
	const { commits } = await reader.read({
		filter: {
			paths: [], authors: ['nobody@example.com'], branches: [], excludeGlobs: [],
			showRemoteBranches: true, showTags: true, grep: null, since: null, until: null, extraArgs: []
		},
		maxCommits: 100, ordering: 'date', onlyFollowFirstParent: false,
		includeCommitsMentionedByReflogs: false, followRenames: false, includeStashes: false
	});

	assert.equal(commits.length, 0, 'an author with no commits yields nothing, not everything');
});

test('resolves revisions and rejects ones that do not exist', async () => {
	const reader = new GitLogReader(git, repo);
	assert.match((await reader.resolve('main')) ?? '', /^[0-9a-f]{40}$/);
	assert.equal(await reader.resolve('no-such-branch'), null);
});

test('attaches annotated tags to the commit, not the tag object', async () => {
	const refReader = new GitRefReader(git, repo);
	const remotes = await refReader.remotes();
	const refs = await refReader.readRefs(remotes);

	const annotated = refs.tags.find((t) => t.name === 'v1.0');
	const lightweight = refs.tags.find((t) => t.name === 'lightweight');
	assert.ok(annotated !== undefined && lightweight !== undefined);
	assert.equal(annotated.annotated, true);
	assert.equal(lightweight.annotated, false);

	const head = (await new GitLogReader(git, repo).resolve('HEAD'))!;
	assert.equal(annotated.hash, head, 'the annotated tag must dereference to its commit');
	assert.equal(lightweight.hash, head);
});

test('reads local branches and their tracking state', async () => {
	const refReader = new GitRefReader(git, repo);
	const refs = await refReader.readRefs(await refReader.remotes());

	assert.deepEqual(refs.heads.map((h) => h.name).sort(), ['feature', 'main']);
	for (const head of refs.heads) {
		assert.equal(head.upstream, null, 'this fixture has no remotes configured');
		assert.equal(head.ahead, null);
	}
});

test('reads the checked out branch and detached HEAD', async () => {
	const refReader = new GitRefReader(git, repo);
	const onBranch = await refReader.readState();
	assert.equal(onBranch.head, 'main');
	assert.equal(onBranch.isDetached, false);
	assert.equal(onBranch.pendingOperation, null);

	fixture(repo, 'checkout', '-q', '--detach', 'HEAD');
	const detached = await refReader.readState();
	assert.equal(detached.head, null);
	assert.equal(detached.isDetached, true);
	assert.match(detached.headHash ?? '', /^[0-9a-f]{40}$/);

	fixture(repo, 'checkout', '-q', 'main');
});

test('reads stash entries with the commit they were taken against', async () => {
	writeFileSync(join(repo, 'a.txt'), 'dirty\n');
	fixture(repo, 'stash', 'push', '-m', 'work in progress');

	const stashes = await new GitRefReader(git, repo).readStashes();
	assert.equal(stashes.length, 1);
	assert.equal(stashes[0].index, 0);
	assert.equal(stashes[0].selector, 'stash@{0}');
	assert.match(stashes[0].message, /work in progress/);
	assert.match(stashes[0].hash, /^[0-9a-f]{40}$/);
	assert.match(stashes[0].baseHash, /^[0-9a-f]{40}$/);

	fixture(repo, 'stash', 'drop');
});

test('detects an interrupted merge so the view can offer to abort it', async () => {
	// Build a genuine conflict: both branches change the same line.
	const conflict = mkdtempSync(join(tmpdir(), 'ggn-conflict-'));
	fixture(conflict, 'init', '-q', '-b', 'main');
	fixture(conflict, 'config', 'user.email', 'test@example.com');
	fixture(conflict, 'config', 'user.name', 'Test');
	commitFile(conflict, 'f.txt', 'base\n', 'base');
	fixture(conflict, 'checkout', '-q', '-b', 'other');
	commitFile(conflict, 'f.txt', 'other\n', 'other side');
	fixture(conflict, 'checkout', '-q', 'main');
	commitFile(conflict, 'f.txt', 'main\n', 'main side');
	try {
		fixture(conflict, '-c', 'commit.gpgsign=false', 'merge', 'other');
	} catch {
		/* the merge is expected to fail with a conflict */
	}

	const state = await new GitRefReader(git, conflict).readState();
	assert.equal(state.pendingOperation, PendingOperation.Merge);

	rmSync(conflict, { recursive: true, force: true });
});
