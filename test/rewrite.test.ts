import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { rewriteParents } from '../src/graph/rewrite.ts';
import type { Commit } from '../src/types.ts';

function commit(hash: string, ...parents: string[]): Commit {
	return {
		hash, parents, author: '', authorEmail: '', authorDate: 0, committer: '', committerEmail: '',
		committerDate: 0, subject: hash, body: '', stash: null
	};
}

const parentsOf = (commits: readonly Commit[]) => Object.fromEntries(commits.map((c) => [c.hash, c.parents]));

test('skips hidden commits in a linear history', () => {
	// d → c → b → a, with c and b hidden.
	const ancestry = new Map([['d', ['c']], ['c', ['b']], ['b', ['a']], ['a', []]]);
	const result = rewriteParents([commit('d', 'c'), commit('a')], ancestry);
	assert.deepEqual(parentsOf(result), { d: ['a'], a: [] });
});

test('keeps both sides of a merge whose parents are hidden', () => {
	// m merges x and y; x → a, y → b; x and y hidden.
	const ancestry = new Map([['m', ['x', 'y']], ['x', ['a']], ['y', ['b']], ['a', []], ['b', []]]);
	const result = rewriteParents([commit('m', 'x', 'y'), commit('a'), commit('b')], ancestry);
	assert.deepEqual(parentsOf(result).m, ['a', 'b']);
});

test('collapses a merge whose sides lead to the same shown commit', () => {
	const ancestry = new Map([['m', ['x', 'y']], ['x', ['a']], ['y', ['a']], ['a', []]]);
	const result = rewriteParents([commit('m', 'x', 'y'), commit('a')], ancestry);
	assert.deepEqual(parentsOf(result).m, ['a']);
});

test('drops a parent whose hidden ancestry ends at a root', () => {
	const ancestry = new Map([['c', ['b']], ['b', []]]);
	assert.deepEqual(parentsOf(rewriteParents([commit('c', 'b')], ancestry)).c, []);
});

test('keeps a parent beyond the walked window, so its edge trails off', () => {
	const ancestry = new Map([['c', ['b']]]);
	assert.deepEqual(parentsOf(rewriteParents([commit('c', 'b')], ancestry)).c, ['b']);
});

test('leaves commits whose parents are all shown untouched', () => {
	const input = [commit('b', 'a'), commit('a')];
	const result = rewriteParents(input, new Map());
	assert.equal(result[0], input[0]);
});

test('survives a very long run of hidden commits without overflowing the stack', () => {
	const length = 100_000;
	const ancestry = new Map<string, string[]>();
	for (let i = length; i > 0; i--) ancestry.set(`h${i}`, [`h${i - 1}`]);
	ancestry.set('h0', []);
	const result = rewriteParents([commit('top', `h${length}`), commit('h0')], ancestry);
	assert.deepEqual(result[0].parents, ['h0']);
});
