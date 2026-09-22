import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { joinArgs, rejectArg, splitArgs, validateArgs } from '../src/git/extraArgs.ts';
import { buildLogArgs, refGlobArgs } from '../src/git/log.ts';
import { globMatches, resolveBranchColours, resolvePins } from '../webview/pins.ts';
import { layoutGraph } from '../src/graph/layout.ts';
import { RefType, emptyFilter, type Commit, type GraphData } from '../src/types.ts';

test('splits arguments with shell quoting but no expansion', () => {
	assert.deepEqual(splitArgs(`--no-merges --since="1 month ago"`), ['--no-merges', '--since=1 month ago']);
	assert.deepEqual(splitArgs(`--grep='it''s'  ^main`), ['--grep=its', '^main']);
	assert.deepEqual(splitArgs(`"a \\"quoted\\" word" back\\ slash`), ['a "quoted" word', 'back slash']);
	assert.deepEqual(splitArgs(`'$(rm -rf ~)'`), ['$(rm -rf ~)'], 'nothing is expanded');
	assert.deepEqual(splitArgs(`   `), []);
	assert.deepEqual(splitArgs(`""`), [''], 'an explicit empty argument is kept');
	assert.throws(() => splitArgs(`--grep="open`), /Unterminated double quote/);
});

test('joins arguments back into text that splits to the same list', () => {
	for (const args of [['--no-merges'], ['--since=1 month ago', "it's"], ['^main', '--grep=(wip)'], ['']]) {
		assert.deepEqual(splitArgs(joinArgs(args)), args);
	}
});

test('rejects arguments that break the graph or have side effects, and allows the rest', () => {
	for (const bad of ['--format=%s', '--pretty=oneline', '--oneline', '-p', '--stat', '--stat=80', '-n5', '-20', '--max-count=3', '--reverse', '-g', '--output=/tmp/x', '--color=always', '--ext-diff', '--']) {
		assert.notEqual(rejectArg(bad), null, `${bad} should be rejected`);
	}
	for (const good of ['--no-merges', '--since=2024-01-01', '^main', '--first-parent', '--simplify-by-decoration', '--skip=10', '--author-date-order', 'main..feature']) {
		assert.equal(rejectArg(good), null, `${good} should be allowed`);
	}
	assert.match(validateArgs(['--no-merges', '--reverse'])!, /"--reverse" is not allowed: it the graph must list children/);
});

test('repeats exclusions before every ref glob, because git clears them after each', () => {
	assert.deepEqual(refGlobArgs({ ...emptyFilter(), excludeGlobs: ['a*', 'b'] }, true), [
		'--exclude=a*', '--exclude=b', '--branches',
		'--exclude=a*', '--exclude=b', '--remotes',
		'--exclude=a*', '--exclude=b', '--tags'
	]);
	assert.deepEqual(refGlobArgs({ ...emptyFilter(), excludeGlobs: ['a*'] }, false), ['--branches', '--remotes', '--tags']);
});

test('always ends revisions with --, with extra arguments before it', () => {
	const args = buildLogArgs(
		{
			filter: { ...emptyFilter(), extraArgs: ['--no-merges'] }, maxCommits: 10, ordering: 'date', onlyFollowFirstParent: false,
			includeCommitsMentionedByReflogs: false, followRenames: false, includeStashes: false
		},
		true
	);
	assert.equal(args[args.length - 1], '--');
	assert.ok(args.indexOf('--no-merges') < args.indexOf('--'));
});

test('matches pin patterns with * across slashes and literal escapes', () => {
	assert.ok(globMatches('main', 'main'));
	assert.ok(!globMatches('main', 'main2'));
	assert.ok(globMatches('release/*', 'release/1.0/hotfix'));
	assert.ok(globMatches('origin/*', 'origin/main'));
	assert.ok(globMatches('v?', 'v1'));
	assert.ok(globMatches('a\\*b', 'a*b'));
	assert.ok(!globMatches('a\\*b', 'axb'));
	assert.ok(globMatches('fix (1)', 'fix (1)'), 'regex characters are literal');
});

function commit(hash: string, ...parents: string[]): Commit {
	return { hash, parents, author: '', authorEmail: '', authorDate: 0, committer: '', committerEmail: '', committerDate: 0, subject: hash, body: '', stash: null };
}

function data(commits: Commit[], heads: [string, string][], remotes: [string, string][] = [], excludedRefs: string[] = []): GraphData {
	return {
		repo: { path: '/r', name: 'r', head: null, headHash: null, isDetached: true, pendingOperation: null },
		commits,
		heads: heads.map(([name, hash]) => ({ type: RefType.Head, name, hash, upstream: null, ahead: null, behind: null })),
		remoteHeads: remotes.map(([name, hash]) => ({ type: RefType.RemoteHead, name, remote: name.split('/')[0], hash })),
		tags: [],
		remoteHeadSymrefs: {},
		moreAvailable: false,
		excludedRefs,
		notedCommits: [],
		issueLinks: [],
		remotes: [],
		commitUrlPrefix: null,
		maxCommits: 100
	};
}

test('resolves pins in pattern order, skipping unloaded, excluded and duplicate tips', () => {
	const d = data(
		[commit('f', 'd'), commit('d', 'm'), commit('m')],
		[['main', 'm'], ['develop', 'd'], ['feature', 'f'], ['gone', 'zzz'], ['alias', 'd'], ['hidden', 'f']],
		[['origin/main', 'm']],
		['refs/heads/hidden']
	);
	assert.deepEqual(resolvePins(d, ['develop', 'main', 'gone']).map((p) => p.name), ['develop', 'main']);
	assert.deepEqual(resolvePins(d, ['hidden']), []);
	assert.deepEqual(resolvePins(d, ['a*', 'develop']).map((p) => p.name), ['alias'], 'develop shares alias’s tip');
	assert.deepEqual(resolvePins(d, ['origin/*']).map((p) => p.name), ['origin/main'], 'remote branches can be pinned');
	assert.deepEqual(resolvePins(d, ['main', 'origin/*']).map((p) => p.name), ['main'], 'origin/main shares main’s tip, so it is not pinned twice');
});

test('a pinned branch keeps one straight column while others weave around it', () => {
	// develop: d3 → d2 → d1; feature forks from d1 and is newer than d2.
	const commits = [commit('d3', 'd2'), commit('f1', 'd1'), commit('d2', 'd1'), commit('d1')];
	const unpinned = layoutGraph(commits).vertices.map((v) => v.column);
	const pinned = layoutGraph(commits, { pinnedBranches: [{ hash: 'd3', name: 'develop' }] }).vertices.map((v) => v.column);
	assert.deepEqual(pinned.filter((_, i) => commits[i].hash.startsWith('d')), [0, 0, 0], 'every develop commit in column 0');
	assert.ok(unpinned.length === pinned.length);
});

test('a fixed branch colour follows its first-parent history, and the rotation never hands it out', () => {
	// main: m3 → m2 → m1, with a feature branch f1 off m1 shown in between.
	const commits = [commit('m3', 'm2'), commit('f1', 'm1'), commit('m2', 'm1'), commit('m1')];
	const layout = layoutGraph(commits, { colourCount: 3, laneColours: new Map([['m3', 7]]) });
	const colourOf = (hash: string) => layout.vertices.find((v) => v.hash === hash)!.colour;
	assert.deepEqual(['m3', 'm2', 'm1'].map(colourOf), [7, 7, 7]);
	assert.ok(colourOf('f1') < 3, 'other lanes keep using the base palette');
});

test('a fixed colour applies even when another lane reaches the tip first', () => {
	// f2's first parent is main's tip m1: the lane arrives from above.
	const commits = [commit('f2', 'm1'), commit('m1', 'm0'), commit('m0')];
	const layout = layoutGraph(commits, { colourCount: 3, laneColours: new Map([['m1', 5]]) });
	assert.deepEqual(layout.vertices.map((v) => v.colour).slice(1), [5, 5]);
});

test('resolves branch colours into an extended palette', () => {
	const d = data([commit('b'), commit('a')], [['main', 'a'], ['release/1', 'b'], ['release/2', 'b']], [['origin/main', 'a']]);
	const { palette, laneColours } = resolveBranchColours(d, ['#111', '#222'], [['release/*', '#f90'], ['main', '#e00'], ['origin/*', '#e00']]);
	assert.deepEqual(palette, ['#111', '#222', '#f90', '#e00'], 'each distinct colour is added once');
	assert.equal(laneColours.get('b'), 2);
	assert.equal(laneColours.get('a'), 3);
	assert.deepEqual(resolveBranchColours(d, ['#111'], []).palette, ['#111']);
});
