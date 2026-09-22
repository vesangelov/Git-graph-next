import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesQuery, parseDate, parseQuery, tokenize, type SearchRef } from '../src/search/query.ts';
import { GitExecutor } from '../src/git/executor.ts';
import { searchHistory } from '../src/git/search.ts';
import type { GraphDataRequest } from '../src/git/graphData.ts';
import { emptyFilter, type Commit } from '../src/types.ts';
import { gitEnv } from './support.ts';

function commit(partial: Partial<Commit>): Commit {
	return {
		hash: 'abcdef0123456789abcdef0123456789abcdef01', parents: [], author: 'Jane Doe', authorEmail: 'jane@example.com',
		authorDate: parseDate('2024-03-15')! + 3600, committer: 'Bot', committerEmail: 'bot@ci', committerDate: parseDate('2024-03-20')!,
		subject: 'Fix null check in parser', body: 'Closes #12 (wip)', stash: null, ...partial
	};
}

const matches = (q: string, c: Commit = commit({}), refs: SearchRef[] = []) => matchesQuery(parseQuery(q)!, c, refs);

test('tokenizes quoted phrases, also after a key', () => {
	assert.deepEqual(tokenize('author:"Jane Doe" fix "null check"'), ['author:Jane Doe', 'fix', 'null check']);
	assert.deepEqual(tokenize('"unclosed phrase'), ['unclosed phrase']);
});

test('an empty query is null', () => {
	assert.equal(parseQuery('   '), null);
	assert.equal(parseQuery(''), null);
});

test('free text must all match, anywhere, case-insensitively and literally', () => {
	assert.ok(matches('fix PARSER'));
	assert.ok(matches('jane'), 'author name');
	assert.ok(matches('example.com'), 'author e-mail');
	assert.ok(matches('abcdef01'), 'hash prefix');
	assert.ok(matches('(wip)'), 'regex metacharacters are literal');
	assert.ok(matches('"null check"'));
	assert.ok(!matches('"check null"'));
	assert.ok(!matches('fix missing'));
});

test('field operators restrict where a term may match', () => {
	assert.ok(matches('author:jane'));
	assert.ok(!matches('author:bot'));
	assert.ok(matches('committer:bot'));
	assert.ok(matches('message:#12'));
	assert.ok(!matches('message:jane'));
	assert.ok(matches('hash:ABCDEF'));
	assert.ok(!matches('hash:bcdef'));
	assert.ok(matches('author:"jane doe" fix'));
});

test('ref operators match names of the right kind', () => {
	const refs: SearchRef[] = [{ name: 'feature/login', kind: 'branch' }, { name: 'v1.2.0', kind: 'tag' }];
	assert.ok(matches('branch:login', commit({}), refs));
	assert.ok(!matches('tag:login', commit({}), refs));
	assert.ok(matches('tag:v1.2', commit({}), refs));
	assert.ok(matches('ref:v1', commit({}), refs));
	assert.ok(matches('v1.2.0', commit({}), refs), 'free text also matches ref names');
});

test('date bounds apply to the author date by default', () => {
	assert.ok(matches('after:2024-03-15'));
	assert.ok(!matches('after:2024-03-16'));
	assert.ok(matches('before:2024-03-16'));
	assert.ok(!matches('before:2024-03-15'), 'before is exclusive of the named day');
	assert.ok(matches('date:2024-03'), 'a bare date means within that period');
	assert.ok(matches('date:>=2024-03-15 date:<=2024-03-15'));
	assert.ok(!matches('date:>2024-03-15'));
	assert.ok(matchesQuery(parseQuery('after:2024-03-18')!, commit({}), [], true), 'or to the commit date when asked');
});

test('unknown prefixes and empty values are plain text', () => {
	assert.deepEqual(parseQuery('fix:parser')!.text, ['fix:parser']);
	assert.deepEqual(parseQuery('author:')!.text, ['author:']);
});

// ---- History search against a real repository ----------------------------

let repo: string;
let git: GitExecutor;

function fixture(...args: string[]): string {
	return execFileSync('git', args, {
		cwd: repo,
		encoding: 'utf8',
		env: gitEnv()
	});
}

const request: GraphDataRequest = {
	filter: emptyFilter(), maxCommits: 5, ordering: 'date', onlyFollowFirstParent: false,
	includeCommitsMentionedByReflogs: false, showUncommittedChanges: false, showUntrackedFiles: false, followRenames: false
};

before(async () => {
	repo = mkdtempSync(join(tmpdir(), 'ggn-search-'));
	fixture('init', '-q', '-b', 'main');
	fixture('config', 'user.email', 'test@example.com');
	fixture('config', 'user.name', 'Test');
	fixture('config', 'commit.gpgsign', 'false');
	fixture('config', 'core.autocrlf', 'false');
	// 30 commits, oldest first; a tag and an unusual author deep in history.
	for (let i = 0; i < 30; i++) {
		writeFileSync(join(repo, 'f.txt'), `${i}\n`);
		fixture('add', 'f.txt');
		const author = i === 3 ? ['-c', 'user.name=Zoë Old', '-c', 'user.email=zoe@old'] : [];
		const date = `2020-01-${String(i + 1).padStart(2, '0')}T12:00:00`;
		execFileSync('git', [...author, 'commit', '-q', '-m', i === 7 ? 'Fix the (legacy) importer' : `commit ${i}`], {
			cwd: repo,
			env: gitEnv({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
		});
		if (i === 5) fixture('tag', 'v0.1');
	}
	git = await GitExecutor.locate(['git']);
});

after(() => rmSync(repo, { recursive: true, force: true }));

// Positions count from the newest commit: commit i sits at 29 - i.

test('finds an unloaded commit by message, literally', async () => {
	const match = await searchHistory(git, repo, request, parseQuery('(legacy) importer')!, 5, false);
	assert.equal(match?.position, 22);
});

test('finds an unloaded commit by author, including non-ASCII names', async () => {
	const match = await searchHistory(git, repo, request, parseQuery('zoë')!, 0, false);
	assert.equal(match?.position, 26);
	const byOperator = await searchHistory(git, repo, request, parseQuery('author:zoe@old')!, 0, false);
	assert.equal(byOperator?.position, 26);
});

test('finds a tag that is not loaded', async () => {
	const match = await searchHistory(git, repo, request, parseQuery('tag:v0.1')!, 0, false);
	assert.equal(match?.position, 24);
	assert.equal((await searchHistory(git, repo, request, parseQuery('v0.1')!, 0, false))?.position, 24, 'as free text too');
});

test('finds a commit by hash prefix', async () => {
	const hash = fixture('rev-list', '-n1', '--skip=10', 'HEAD').trim();
	const match = await searchHistory(git, repo, request, parseQuery(hash.slice(0, 7))!, 0, false);
	assert.deepEqual(match, { hash, position: 10 });
});

test('continues after a position, and reports when nothing further matches', async () => {
	// The phrase "commit 2" is in commits 20–29 (positions 0–9) and commit 2 (position 27).
	assert.equal((await searchHistory(git, repo, request, parseQuery('"commit 2"')!, 0, false))?.position, 0);
	assert.equal((await searchHistory(git, repo, request, parseQuery('"commit 2"')!, 10, false))?.position, 27);
	const none = await searchHistory(git, repo, request, parseQuery('importer')!, 23, false);
	assert.equal(none, null);
});

test('applies date bounds', async () => {
	const match = await searchHistory(git, repo, request, parseQuery('before:2020-01-03')!, 0, false);
	assert.equal(match?.position, 28, 'commit 1 is dated 2 Jan');
});
