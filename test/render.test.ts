import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { edgePath, type GraphGeometry } from '../webview/render/graph.ts';
import { buildLabels } from '../webview/render/table.ts';
import { formatDate, relativeTime } from '../webview/format.ts';
import { RefType, type GraphData, type GraphEdge } from '../src/types.ts';

const geometry: GraphGeometry = { rowHeight: 20, columnWidth: 10, paddingLeft: 5, style: 'angular' };

function edge(partial: Partial<GraphEdge>): GraphEdge {
	return { fromIndex: 0, toIndex: 1, fromColumn: 0, toColumn: 0, laneColumn: 0, colour: 0, dashed: false, ...partial };
}

test('a straight edge is a single vertical segment between row centres', () => {
	assert.equal(edgePath(edge({ fromIndex: 0, toIndex: 3 }), geometry, 10), 'M5,10L5,70');
});

test('a merge edge bends out within the first row, then runs down its lane', () => {
	const d = edgePath(edge({ fromIndex: 0, toIndex: 4, fromColumn: 0, laneColumn: 2, toColumn: 2 }), geometry, 10);
	assert.equal(d, 'M5,10L25,30L25,90');
});

test('a converging edge runs down its lane and bends in within the last row', () => {
	const d = edgePath(edge({ fromIndex: 0, toIndex: 4, fromColumn: 1, laneColumn: 1, toColumn: 0 }), geometry, 10);
	assert.equal(d, 'M15,10L15,70L5,90');
});

test('an edge needing two bends across adjacent rows goes straight to the parent', () => {
	const d = edgePath(edge({ fromIndex: 2, toIndex: 3, fromColumn: 0, laneColumn: 1, toColumn: 0 }), geometry, 10);
	assert.equal(d, 'M5,50L5,70');
});

test('an edge to an unloaded parent trails past the last row', () => {
	const d = edgePath(edge({ fromIndex: 8, toIndex: -1, fromColumn: 1, laneColumn: 1, toColumn: 1 }), geometry, 10);
	assert.equal(d, 'M15,170L15,220');
});

test('rounded edges use curves where angular ones use lines', () => {
	const d = edgePath(edge({ fromIndex: 0, toIndex: 4, fromColumn: 0, laneColumn: 2, toColumn: 2 }), { ...geometry, style: 'rounded' }, 10);
	assert.match(d, /^M5,10C5,20 25,20 25,30L25,90$/);
});

function data(): GraphData {
	const h = (c: string) => c.repeat(40);
	return {
		repo: { path: '/r', name: 'r', head: 'main', headHash: h('a'), isDetached: false, pendingOperation: null },
		commits: [],
		heads: [
			{ type: RefType.Head, name: 'main', hash: h('a'), upstream: 'origin/main', ahead: 0, behind: 0 },
			{ type: RefType.Head, name: 'feature', hash: h('b'), upstream: null, ahead: null, behind: null }
		],
		remoteHeads: [
			{ type: RefType.RemoteHead, name: 'origin/main', remote: 'origin', hash: h('a') },
			{ type: RefType.RemoteHead, name: 'origin/feature', remote: 'origin', hash: h('c') }
		],
		tags: [{ type: RefType.Tag, name: 'v1', hash: h('a'), annotated: true }],
		remoteHeadSymrefs: { origin: 'origin/main' },
		moreAvailable: false,
		excludedRefs: [],
		maxCommits: 100
	};
}

test('folds a remote branch into the local label only when both point at the same commit', () => {
	const labels = buildLabels(data(), { combineLocalAndRemoteBranchLabels: true, showRemoteHeads: true });
	const onA = labels.get('a'.repeat(40))!;
	assert.deepEqual(onA.map((l) => [l.kind, l.name, l.remotes]), [['head', 'main', ['origin']], ['tag', 'v1', []]]);
	assert.equal(onA[0].current, true);
	// origin/feature is elsewhere, so it keeps a label of its own.
	assert.deepEqual(labels.get('c'.repeat(40))!.map((l) => l.name), ['origin/feature']);
});

test('keeps remote labels separate when combining is off', () => {
	const labels = buildLabels(data(), { combineLocalAndRemoteBranchLabels: false, showRemoteHeads: true });
	assert.deepEqual(labels.get('a'.repeat(40))!.map((l) => l.name), ['main', 'origin/main', 'v1']);
});

test('formats dates in each configured style', () => {
	const seconds = new Date(2026, 8, 21, 9, 5).getTime() / 1000;
	assert.equal(formatDate(seconds, 'Date & Time'), '21 Sep 2026 09:05');
	assert.equal(formatDate(seconds, 'ISO Date Only'), '2026-09-21');
	assert.equal(relativeTime(seconds, (seconds + 7200) * 1000), '2 hours ago');
	assert.equal(relativeTime(seconds, (seconds + 60) * 1000), '1 minute ago');
});
