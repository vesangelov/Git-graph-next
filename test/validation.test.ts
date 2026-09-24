import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isRepoRelativePath, parseRevisionQuery } from '../src/view/validation.ts';
import { STAGED } from '../src/types.ts';

const HASH = 'a'.repeat(40);
const query = (value: Record<string, unknown>) => JSON.stringify(value);

test('accepts only paths that stay inside the repository', () => {
	for (const path of ['a.txt', 'src/deep/file.ts', 'файл с интервал.txt', '.github/workflows/ci.yml', 'a..b.txt', '...']) {
		assert.ok(isRepoRelativePath(path), path);
	}
	for (const path of ['', '../outside.txt', 'src/../../outside', '/etc/passwd', '\\\\server\\share', 'C:/Windows/win.ini', 'c:secret', 'src\\..\\..\\x', 'a\0b', 42, null]) {
		assert.ok(!isRepoRelativePath(path), JSON.stringify(path));
	}
});

test('parses the revision URIs the extension makes, and nothing else', () => {
	assert.deepEqual(parseRevisionQuery(query({ repo: '/r', revision: HASH, path: 'a.txt' })), { repo: '/r', revision: HASH, path: 'a.txt' });
	assert.deepEqual(parseRevisionQuery(query({ repo: '/r', revision: 'b'.repeat(64), path: 'a.txt' }))?.revision, 'b'.repeat(64), 'SHA-256');
	assert.equal(parseRevisionQuery(query({ repo: '/r', revision: STAGED, path: 'a.txt' }))?.revision, STAGED, 'the index');
	assert.equal(parseRevisionQuery(query({ repo: '/r', revision: '', path: 'a.txt' }))?.revision, '', 'an empty side');

	// What a crafted URI could carry instead.
	for (const bad of [
		query({ repo: '/r', revision: '--output=/tmp/x', path: 'a.txt' }),
		query({ repo: '/r', revision: 'HEAD', path: 'a.txt' }),
		query({ repo: '/r', revision: HASH.slice(0, 12), path: 'a.txt' }),
		query({ repo: '/r', revision: HASH, path: '../../etc/passwd' }),
		query({ repo: '', revision: HASH, path: 'a.txt' }),
		query({ repo: '/r', revision: HASH }),
		'not json',
		'null',
		'[]'
	]) {
		assert.equal(parseRevisionQuery(bad), null, bad);
	}
});
