import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { layoutGraph } from '../src/graph/layout.ts';
import type { Commit } from '../src/types.ts';

/** Builds a commit whose hash is a readable stand-in for a real object id. */
function pad(name: string): string {
	return name.padEnd(40, '0');
}

function commit(name: string, ...parents: string[]): Commit {
	return {
		hash: pad(name),
		parents: parents.map(pad),
		author: 'A',
		authorEmail: 'a@a',
		authorDate: 0,
		committer: 'A',
		committerEmail: 'a@a',
		committerDate: 0,
		subject: name,
		body: '',
		stash: null
	};
}

function columnsOf(commits: readonly Commit[], options = {}): number[] {
	return layoutGraph(commits, options).vertices.map((v) => v.column);
}

test('linear history stays in one column with one colour', () => {
	const commits = [commit('c', 'b'), commit('b', 'a'), commit('a')];
	const layout = layoutGraph(commits);

	assert.deepEqual(columnsOf(commits), [0, 0, 0]);
	assert.equal(layout.width, 1);
	assert.equal(new Set(layout.vertices.map((v) => v.colour)).size, 1, 'a straight branch must not change colour');
});

test('a root commit releases its lane for reuse', () => {
	// Two unrelated roots: the second must reuse column 0, not open column 1.
	const commits = [commit('b'), commit('a')];
	assert.deepEqual(columnsOf(commits), [0, 0]);
});

test('a branch and merge places the merged branch to the right', () => {
	//   m      merge of main and feature
	//   |\
	//   | f    feature
	//   b |    main moved on
	//   |/
	//   a
	const commits = [commit('m', 'b', 'f'), commit('b', 'a'), commit('f', 'a'), commit('a')];
	const layout = layoutGraph(commits);

	assert.deepEqual(
		layout.vertices.map((v) => v.column),
		[0, 0, 1, 0],
		'the first parent keeps column 0; the merged branch takes column 1'
	);
	assert.equal(layout.width, 2);
});

test('the first parent inherits the colour, the merged branch gets its own', () => {
	const commits = [commit('m', 'b', 'f'), commit('b', 'a'), commit('f', 'a'), commit('a')];
	const [m, b, f, a] = layoutGraph(commits).vertices;

	assert.equal(m.colour, b.colour, 'a merge and its first parent are one branch');
	assert.notEqual(f.colour, m.colour, 'the merged-in branch is visually distinct');
	assert.equal(a.colour, m.colour, 'the base commit keeps the mainline colour');
});

test('converging lanes merge into the leftmost column', () => {
	// Both b and f lead back to a, so a is drawn on the leftmost lane.
	const commits = [commit('m', 'b', 'f'), commit('b', 'a'), commit('f', 'a'), commit('a')];
	const layout = layoutGraph(commits);
	const a = layout.vertices[3];

	assert.equal(a.column, 0);
	const intoA = layout.edges.filter((e) => e.toIndex === 3);
	assert.equal(intoA.length, 2, 'both branches draw an edge into the shared ancestor');
	assert.deepEqual(
		intoA.map((e) => e.fromColumn).sort(),
		[0, 1],
		'the edges leave from the columns their children occupy'
	);
});

test('two independent tips occupy separate columns', () => {
	const commits = [commit('x', 'a'), commit('y', 'a'), commit('a')];
	assert.deepEqual(columnsOf(commits), [0, 1, 0]);
});

test('a pinned branch keeps column 0 even when it is not the first commit', () => {
	// `feature` is newest, but `main` is pinned, so main owns column 0 and its
	// line stays straight instead of weaving (#207).
	const commits = [commit('f', 'a'), commit('m', 'a'), commit('a')];
	const layout = layoutGraph(commits, {
		pinnedBranches: [{ hash: pad('m'), name: 'main' }]
	});

	assert.equal(layout.vertices[1].column, 0, 'the pinned branch tip sits in its reserved column');
	assert.equal(layout.vertices[0].column, 1, 'the unpinned branch is pushed right');
});

test('a pinned column is not reused by unrelated branches', () => {
	const commits = [commit('f'), commit('g'), commit('m', 'a'), commit('a')];
	const layout = layoutGraph(commits, {
		pinnedBranches: [{ hash: pad('m'), name: 'main' }]
	});

	const columns = layout.vertices.map((v) => v.column);
	assert.equal(columns[2], 0, 'main stays in its reserved column');
	assert.ok(!columns.slice(0, 2).includes(0), 'root commits above it must not squat in column 0');
});

test('commits whose parents were not loaded keep a trailing edge', () => {
	// Only the tip is loaded; its parent is below the loaded window.
	const layout = layoutGraph([commit('c', 'b')]);
	const trailing = layout.edges.filter((e) => e.toIndex === -1);

	assert.equal(trailing.length, 1, 'the edge must continue off the bottom of the view');
	assert.equal(trailing[0].fromIndex, 0);
});

test('an octopus merge opens a lane per additional parent', () => {
	const commits = [commit('o', 'a', 'b', 'c'), commit('a'), commit('b'), commit('c')];
	const layout = layoutGraph(commits);

	assert.deepEqual(layout.vertices.map((v) => v.column), [0, 0, 1, 2]);
	assert.equal(layout.edges.filter((e) => e.fromIndex === 0).length, 3, 'one edge per parent');
});

test('the uncommitted changes row draws a dashed edge', () => {
	const uncommitted = '*'.repeat(40);
	const commits: Commit[] = [
		{ ...commit('head'), hash: uncommitted, parents: [pad('head')] },
		commit('head')
	];
	const layout = layoutGraph(commits, { uncommittedHash: uncommitted });

	const edge = layout.edges.find((e) => e.fromIndex === 0);
	assert.ok(edge !== undefined);
	assert.equal(edge.dashed, true);
	assert.equal(layout.edges.filter((e) => e.dashed).length, 1, 'only that one edge is dashed');
});

test('colours cycle within the configured palette size', () => {
	const commits = [commit('a'), commit('b'), commit('c'), commit('d')];
	const layout = layoutGraph(commits, { colourCount: 2 });

	for (const vertex of layout.vertices) {
		assert.ok(vertex.colour >= 0 && vertex.colour < 2, `colour ${vertex.colour} is outside the palette`);
	}
});

test('every edge references a real row and column', () => {
	const commits = [commit('m', 'b', 'f'), commit('b', 'a'), commit('f', 'a'), commit('a')];
	const layout = layoutGraph(commits);

	for (const edge of layout.edges) {
		assert.ok(edge.fromIndex >= 0 && edge.fromIndex < commits.length);
		assert.ok(edge.toIndex === -1 || (edge.toIndex > edge.fromIndex && edge.toIndex < commits.length),
			'an edge must point downwards to a loaded row');
		assert.ok(edge.laneColumn >= 0 && edge.laneColumn < layout.width);
	}
});
