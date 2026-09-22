import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { collapseRuns, runContaining } from '../src/graph/collapse.ts';
import { layoutGraph } from '../src/graph/layout.ts';
import { UNCOMMITTED, type Commit } from '../src/types.ts';

function commit(hash: string, ...parents: string[]): Commit {
	return { hash, parents, author: '', authorEmail: '', authorDate: 0, committer: '', committerEmail: '', committerDate: 0, subject: hash, body: '', stash: null };
}

/** tip → c5 → c4 → c3 → c2 → c1 → root, a single line. */
const line = [commit('tip', 'c5'), commit('c5', 'c4'), commit('c4', 'c3'), commit('c3', 'c2'), commit('c2', 'c1'), commit('c1', 'root'), commit('root')];

test('folds a linear run into one row that keeps the graph connected', () => {
	const view = collapseRuns(line, new Set(), new Set());
	assert.deepEqual(view.commits.map((c) => c.subject), ['tip', '5 commits', 'root']);
	const standIn = view.commits[1];
	assert.equal(standIn.hash, 'c5', 'the stand-in keeps the first hash, so tip still points at it');
	assert.deepEqual(standIn.parents, ['root'], 'and takes the last commit’s parent');
	assert.deepEqual(view.runs.get('c5')!.map((c) => c.hash), ['c5', 'c4', 'c3', 'c2', 'c1']);
	const layout = layoutGraph(view.commits);
	assert.ok(layout.edges.every((e) => e.toIndex !== -1), 'no dangling edges');
});

test('kept commits split runs, and short runs are not folded', () => {
	const view = collapseRuns(line, new Set(['c3']), new Set());
	assert.deepEqual(view.commits.map((c) => c.subject), ['tip', 'c5', 'c4', 'c3', 'c2', 'c1', 'root'], 'two runs of 2 remain unfolded');
	const longer = collapseRuns(line, new Set(['c2']), new Set());
	assert.deepEqual(longer.commits.map((c) => c.subject), ['tip', '3 commits', 'c2', 'c1', 'root']);
});

test('branch points, merges and synthetic rows are never folded', () => {
	// m merges b into a; x and y both have p as parent (a branch point).
	const commits = [
		{ ...commit(UNCOMMITTED, 'm'), subject: 'uncommitted' },
		commit('m', 'a', 'b'), commit('a', 'x'), commit('b', 'y'), commit('x', 'p'), commit('y', 'p'), commit('p')
	];
	assert.equal(collapseRuns(commits, new Set(), new Set(), 2).runs.size, 0, 'no adjacent first-parent run is plain enough');
});

test('expanded runs show in full, and a folded commit can be found', () => {
	const view = collapseRuns(line, new Set(), new Set());
	assert.equal(runContaining(view.runs, 'c3'), 'c5');
	assert.equal(runContaining(view.runs, 'tip'), null);
	assert.equal(collapseRuns(line, new Set(), new Set(['c5'])).commits.length, line.length);
});
