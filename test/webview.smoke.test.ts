/**
 * Boots the real webview code in a simulated DOM and drives it with host
 * messages, the way the extension host does. Not a visual test: it catches
 * runtime errors and broken wiring that the type checker cannot see.
 */
import { strict as assert } from 'node:assert';
import { before, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { PendingOperation, RefType, UNCOMMITTED, type Commit, type GraphData } from '../src/types.ts';
import type { HostMessage, ViewConfig, WebviewMessage } from '../src/view/protocol.ts';

const posted: WebviewMessage[] = [];
let dom: JSDOM;

const h = (n: number) => n.toString(16).padStart(40, '0');
function commit(n: number, parents: number[], extra: Partial<Commit> = {}): Commit {
	return {
		hash: h(n), parents: parents.map(h), author: n % 2 ? 'Alice' : 'Bob', authorEmail: 'a@x', authorDate: 1_700_000_000 - n * 3600,
		committer: 'Alice', committerEmail: 'a@x', committerDate: 1_700_000_000 - n * 3600, subject: `commit ${n} fixes #${n}`, body: '', stash: null, ...extra
	};
}

const config: ViewConfig = {
	colours: ['#0085d9', '#d9008f', '#00d90a'], graphStyle: 'rounded', dateType: 'Author Date', dateFormat: 'Date & Time', stickyHeader: true,
	combineLocalAndRemoteBranchLabels: true, showRemoteHeads: true, maxCommits: 300, loadMoreCommits: 100, loadMoreCommitsAutomatically: true,
	showRemoteBranches: true, showTags: true, pinnedBranches: ['main'], branchColours: [['main', '#ff0000']], colourRows: true,
	fetchAndPrune: false, fetchAndPruneTags: false
};

/** A linear main of 30 commits, a feature branch off commit 20, a tag, and uncommitted changes. */
function graph(pendingOperation: PendingOperation | null = null): GraphData {
	const commits: Commit[] = [{ ...commit(0, [1]), hash: UNCOMMITTED, subject: 'Uncommitted Changes (2)' }];
	commits.push(commit(100, [20]));
	for (let n = 1; n <= 30; n++) commits.push(commit(n, n < 30 ? [n + 1] : []));
	return {
		repo: { path: '/repo', name: 'repo', head: 'main', headHash: h(1), isDetached: false, pendingOperation },
		commits,
		heads: [
			{ type: RefType.Head, name: 'main', hash: h(1), upstream: 'origin/main', ahead: 0, behind: 0 },
			{ type: RefType.Head, name: 'feature', hash: h(100), upstream: null, ahead: null, behind: null }
		],
		remoteHeads: [{ type: RefType.RemoteHead, name: 'origin/main', remote: 'origin', hash: h(1) }],
		tags: [{ type: RefType.Tag, name: 'v1.0', hash: h(10), annotated: true }],
		remoteHeadSymrefs: { origin: 'origin/main' },
		moreAvailable: false,
		remotes: ['origin'],
		issueLinks: [{ pattern: '#(\\d+)', url: 'https://example.test/issues/$1' }],
		notedCommits: [h(5)],
		excludedRefs: [],
		maxCommits: 300
	};
}

function send(message: HostMessage): void {
	dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
}

const doc = () => dom.window.document;
const flush = () => new Promise((resolve) => dom.window.setTimeout(resolve, 350));
const lastPosted = <T extends WebviewMessage['type']>(type: T) =>
	[...posted].reverse().find((m) => m.type === type) as Extract<WebviewMessage, { type: T }> | undefined;

function rightClick(element: Element): void {
	element.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
}

function menuItem(label: string): HTMLElement {
	const item = [...doc().querySelectorAll<HTMLElement>('.context-menu .item')].find((i) => i.textContent === label);
	assert.ok(item !== undefined, `menu item "${label}" in ${[...doc().querySelectorAll('.context-menu .item')].map((i) => i.textContent).join(', ')}`);
	return item;
}

before(async () => {
	dom = new JSDOM('<!DOCTYPE html><html><body data-mode="panel"><div id="app"></div></body></html>', { pretendToBeVisual: true });
	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'Node', 'InputEvent', 'MouseEvent', 'KeyboardEvent']) {
		g[name] = (dom.window as unknown as Record<string, unknown>)[name];
	}
	class ResizeObserverStub {
		observe(): void {}
		disconnect(): void {}
	}
	g.ResizeObserver = ResizeObserverStub;
	(dom.window as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
	g.acquireVsCodeApi = () => ({ postMessage: (m: WebviewMessage) => posted.push(m), getState: () => undefined, setState: () => undefined });
	await import('../webview/main.ts');
});

test('announces itself and loads the selected repository', async () => {
	assert.equal(posted[0]?.type, 'ready');
	send({ type: 'config', config });
	send({ type: 'repos', repos: [{ path: '/repo', name: 'repo' }], selected: '/repo' });
	const load = lastPosted('load');
	assert.equal(load?.options.repo, '/repo');
});

test('renders rows, labels, issue links and the graph', async () => {
	send({ type: 'graph', data: graph() });
	await flush();
	const rows = doc().querySelectorAll('.row.commit');
	assert.ok(rows.length > 10, `rows rendered: ${rows.length}`);
	assert.ok(doc().querySelector('.label.head.current') !== null, 'the checked-out branch label');
	assert.ok(doc().querySelector('.label.note') !== null, 'the git-note badge');
	assert.ok(doc().querySelectorAll('a.issue-link').length > 0, 'issue references become links');
	assert.ok(doc().querySelectorAll('.graph-svg path.edge').length > 0, 'edges drawn');
	assert.ok(doc().querySelector('.row.commit.coloured') !== null, 'branch colour on rows');
});

test('offers commit actions and runs one through a dialog, showing git errors in place', async () => {
	const row = [...doc().querySelectorAll('.row.commit')].find((r) => r.textContent?.includes('commit 5 '))!;
	rightClick(row);
	menuItem('Create Branch…').click();
	const dialog = doc().querySelector('.dialog-backdrop') as HTMLElement;
	assert.equal(dialog.hidden, false);
	const name = dialog.querySelector('input:not([type=checkbox])') as HTMLInputElement;
	name.value = 'topic';
	(dialog.querySelector('form') as HTMLFormElement).requestSubmit();

	const request = lastPosted('runAction')!;
	assert.deepEqual(request.action, { kind: 'createBranch', name: 'topic', startPoint: h(5), checkout: false, force: false });
	send({ type: 'actionResult', requestId: request.requestId, error: "fatal: a branch named 'topic' already exists" });
	await flush();
	assert.equal(dialog.hidden, false, 'stays open on error');
	assert.match(dialog.querySelector('.dialog-error')!.textContent!, /already exists/);

	name.value = 'topic2';
	(dialog.querySelector('form') as HTMLFormElement).requestSubmit();
	send({ type: 'actionResult', requestId: lastPosted('runAction')!.requestId, error: null });
	await flush();
	assert.equal(dialog.hidden, true, 'closes on success');
});

test('offers branch actions on labels, and destructive ones behind a warning', async () => {
	const feature = [...doc().querySelectorAll('.label.head')].find((l) => l.textContent?.startsWith('feature'))!;
	rightClick(feature);
	for (const label of ['Check Out feature', 'Merge into main…', 'Rebase main onto feature…', 'Push…', 'Rename…', 'Delete…', 'Pin to Own Column', 'Copy Branch Name']) menuItem(label);
	menuItem('Delete…').click();
	assert.ok(doc().querySelector('.dialog.danger') !== null);
	(doc().querySelector('.dialog-button.secondary') as HTMLElement).click();
	assert.equal((doc().querySelector('.dialog-backdrop') as HTMLElement).hidden, true);
});

test('shows an interrupted merge with Continue and Abort', async () => {
	send({ type: 'graph', data: graph(PendingOperation.Merge) });
	await flush();
	const banner = doc().querySelector('.pending-banner') as HTMLElement;
	assert.equal(banner.hidden, false);
	const continueButton = [...banner.querySelectorAll('button')].find((b) => b.textContent === 'Continue')!;
	continueButton.click();
	assert.deepEqual(lastPosted('runAction')!.action, { kind: 'continueOperation', operation: 'merge' });
	send({ type: 'actionResult', requestId: lastPosted('runAction')!.requestId, error: null });
	send({ type: 'graph', data: graph() });
	await flush();
	assert.equal(banner.hidden, true);
});

test('searches, and folds history in compact mode', async () => {
	doc().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
	const input = doc().querySelector('.search-input') as HTMLInputElement;
	assert.equal((doc().querySelector('.search-bar') as HTMLElement).hidden, false);
	input.value = 'author:alice';
	input.dispatchEvent(new dom.window.Event('input'));
	await flush();
	assert.match(doc().querySelector('.search-count')!.textContent!, /^1 of \d+$/);
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

	const before = doc().querySelectorAll('.row.commit').length;
	const compact = [...doc().querySelectorAll('.toolbar button')].find((b) => b.textContent === 'Compact') as HTMLElement;
	compact.click();
	await flush();
	assert.ok(doc().querySelector('.row.commit.collapsed') !== null, 'a folded run');
	assert.ok(doc().querySelectorAll('.row.commit').length < before);
});
