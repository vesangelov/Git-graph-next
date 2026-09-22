/**
 * Code review in the webview: the buttons, the progress, and the messages
 * they send. The host side (ReviewManager) needs VS Code and is checked live.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isValidTarget } from '../src/view/validation.ts';
import { UNCOMMITTED } from '../src/types.ts';

const h = (c: string) => c.repeat(40);

test('accepts only well-formed targets for known repositories', () => {
	const repos = ['/repo'];
	assert.ok(isValidTarget({ repo: '/repo', hash: h('a'), base: h('b') }, repos));
	assert.ok(isValidTarget({ repo: '/repo', hash: UNCOMMITTED, base: h('b') }, repos));
	assert.ok(isValidTarget({ repo: '/repo', hash: h('a'), base: null }, repos));
	assert.ok(!isValidTarget({ repo: '/other', hash: h('a'), base: null }, repos), 'unknown repository');
	assert.ok(!isValidTarget({ repo: '/repo', hash: '--output=/tmp/x', base: null }, repos), 'option-like hash');
	assert.ok(!isValidTarget({ repo: '/repo', hash: h('a'), base: 'HEAD~1' }, repos), 'revision expressions are not hashes');
	assert.ok(!isValidTarget(null, repos));
});
