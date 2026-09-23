import { strict as assert } from 'node:assert';
import { after, beforeEach, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AvatarService } from '../src/view/avatars.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

let root: string;
let file: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'ggn-avatars-'));
	file = join(root, 'cache', 'avatars.json');
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Waits out the service's write debounce plus the write itself. */
function flush(service: AvatarService): Promise<void> {
	service.dispose();
	return new Promise((resolve) => setTimeout(resolve, 50));
}

test('reads a cache written earlier, and never asks the network for what it has', async () => {
	writeFileSync(join(root, 'cache.json'), JSON.stringify({ 'a@e.com': PNG, 'b@e.com': null }));
	const service = new AvatarService(join(root, 'cache.json'));

	// fetch is not stubbed: a request here would fail the test by timing out
	// or by returning something that is not this file's contents.
	const result = await service.get(['A@E.com ', 'b@e.com']);
	assert.deepEqual(result, { 'a@e.com': PNG, 'b@e.com': null }, 'addresses are matched lowercased and trimmed');
});

test('ignores entries that are not data URIs, so a tampered file cannot point the webview elsewhere', async () => {
	writeFileSync(join(root, 'cache.json'), JSON.stringify({ 'a@e.com': 'https://evil.example/track.png', 'b@e.com': PNG }));
	const service = new AvatarService(join(root, 'cache.json'));
	const result = await service.get(['a@e.com', 'b@e.com']);
	assert.equal(result['a@e.com'], null, 'a remote address is dropped');
	assert.equal(result['b@e.com'], PNG);
});

test('survives a missing, empty or corrupt cache file', async () => {
	for (const contents of [null, '', '{', '[]', 'null']) {
		const path = join(root, `c-${contents === null ? 'missing' : contents.length}.json`);
		if (contents !== null) writeFileSync(path, contents);
		const service = new AvatarService(path);
		assert.deepEqual(await service.get([]), {}, `contents: ${JSON.stringify(contents)}`);
	}
});

test('creates the storage directory, and clearing removes the file', async () => {
	writeFileSync(join(root, 'seed.json'), JSON.stringify({ 'a@e.com': PNG }));
	const seeded = new AvatarService(join(root, 'seed.json'));
	await seeded.get(['a@e.com']);

	// The directory does not exist yet: the service must create it to write.
	assert.ok(!existsSync(join(root, 'cache')));
	const service = new AvatarService(file);
	await service.get([]);

	// Nothing was fetched, so nothing is written; clearing is still safe.
	await service.clear();
	assert.ok(!existsSync(file));
});

test('skips addresses that are not addresses at all', async () => {
	const service = new AvatarService(file);
	assert.deepEqual(await service.get(['', '   ', 'not-an-address']), {}, 'no request is made for these');
	await flush(service);
});

test('drops a cache left behind in the Memento instead of loading it', async () => {
	const stored: Record<string, unknown> = { 'gitGraphNext.avatars': { 'a@e.com': PNG } };
	const memento = {
		get: (key: string) => stored[key],
		update: async (key: string, value: unknown) => {
			if (value === undefined) delete stored[key];
			else stored[key] = value;
		},
		keys: () => Object.keys(stored)
	};

	const service = new AvatarService(file, memento as never);
	const result = await service.get(['a@e.com']);
	assert.equal(result['a@e.com'], null, 'the old entry is not carried over');
	assert.equal(stored['gitGraphNext.avatars'], undefined, 'and the Memento no longer pays for it');
});

test('does not rewrite the file when every address was already cached', async () => {
	// Scrolling a graph asks for the same authors over and over; a lookup that
	// fetched nothing must not cost a write each time.
	const path = join(root, 'seed.json');
	writeFileSync(path, JSON.stringify({ 'a@e.com': PNG, 'b@e.com': null }));
	const before = readFileSync(path, 'utf8');

	const service = new AvatarService(path);
	for (let i = 0; i < 5; i++) await service.get(['a@e.com', 'b@e.com']);
	await flush(service);

	assert.equal(readFileSync(path, 'utf8'), before, 'the file is untouched');
});
