import { layoutGraph } from '../src/graph/layout.ts';
import { FileChangeType, UNCOMMITTED, type ChangeTarget, type Commit, type FileChange, type GitAction, type GraphData, type Hash } from '../src/types.ts';
import { NO_FILTER, completeFilter, isFiltered, type FilterState, type HostMessage, type LoadOptions, type PersistedViewState, type RepoOption, type ViewConfig, type ViewMode, type WebviewMessage } from '../src/view/protocol.ts';
import { FilterControls } from './filters.ts';
import { collapseRuns, runContaining } from '../src/graph/collapse.ts';
import { escapeGlob, globMatches, resolveBranchColours, resolvePins } from './pins.ts';
import { SearchBar, type SearchStatus } from './search.ts';
import { highlightTerms, matchesQuery, parseQuery, type SearchQuery, type SearchRef } from '../src/search/query.ts';
import { DetailsPane, changeTarget } from './details.ts';
import { Dialog } from './dialog.ts';
import { commitActions, fetchDialog, labelActions, pendingOperationActions, runNow, type ActionContext } from './actionMenus.ts';
import { shortHash } from './format.ts';
import { ContextMenu, type MenuItem } from './menu.ts';
import { CommitTable, buildLabels, el, type RefLabel } from './render/table.ts';

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): PersistedViewState | undefined;
	setState(state: PersistedViewState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const mode: ViewMode = document.body.dataset.mode === 'sidebar' ? 'sidebar' : 'panel';

/** Delay before a filter change reloads, so ticking several branches in a row loads once. */
const FILTER_DEBOUNCE_MS = 300;

/** Delay before a keyboard-driven selection loads its files, so holding ↓ does not queue a load per row. */
const SELECT_DEBOUNCE_MS = 120;

/** The whole client-side state; everything on screen is derived from it. */
const state = {
	config: null as ViewConfig | null,
	repos: [] as readonly RepoOption[],
	repo: null as string | null,
	data: null as GraphData | null,
	loading: false,
	error: null as string | null,
	/** Remote-branch toggle; null until the user changes it, meaning "use the setting". */
	showRemoteBranches: null as boolean | null,
	/** Scroll position to apply once the first graph for the restored repo arrives. */
	restoreScrollTop: null as number | null,
	detailsHeight: null as number | null,
	/** Filter per repository path. The sidebar never filters. */
	filters: {} as Record<string, FilterState>,
	/** Branch names pinned from the context menu, per repository (#207). */
	pins: {} as Record<string, readonly string[]>,
	/** Author names seen per repository, offered as filter suggestions. */
	authors: new Map<string, Set<string>>(),
	/** Fold plain linear history into single rows (#387). */
	compact: false,
	/** Collapsed runs the user expanded, by first hash. Cleared on reload of another repo. */
	expanded: new Set<Hash>(),
	/** Runs folded in the rows on screen, by stand-in hash. */
	runs: new Map<Hash, readonly Commit[]>() as ReadonlyMap<Hash, readonly Commit[]>
};

const saved = vscode.getState();
if (saved !== undefined) {
	state.repo = saved.repo;
	state.showRemoteBranches = saved.showRemoteBranches;
	state.restoreScrollTop = saved.scrollTop;
	state.detailsHeight = saved.detailsHeight ?? null;
	if (mode === 'panel') {
		for (const [repo, filter] of Object.entries(saved.filters ?? {})) state.filters[repo] = completeFilter(filter);
	}
	state.pins = { ...saved.pins };
	state.compact = saved.compact === true;
}

function currentFilter(): FilterState {
	return (state.repo !== null ? state.filters[state.repo] : undefined) ?? NO_FILTER;
}

function post(message: WebviewMessage): void {
	vscode.postMessage(message);
}

let saveTimer = 0;
function persist(): void {
	window.clearTimeout(saveTimer);
	saveTimer = window.setTimeout(() => {
		vscode.setState({
			repo: state.repo,
			scrollTop: table.scrollTop,
			showRemoteBranches: state.showRemoteBranches,
			detailsHeight: state.detailsHeight,
			filters: state.filters,
			pins: state.pins,
			compact: state.compact
		});
	}, 200);
}

// ---- DOM ------------------------------------------------------------------

const app = document.getElementById('app')!;
const toolbar = el('div', 'toolbar');

const repoLabel = el('label', 'control');
repoLabel.appendChild(el('span', '', 'Repo'));
const repoSelect = el('select');
repoSelect.title = 'Repository';
repoLabel.appendChild(repoSelect);

const remoteLabel = el('label', 'control');
const remoteCheckbox = el('input');
remoteCheckbox.type = 'checkbox';
remoteLabel.append(remoteCheckbox, el('span', '', 'Show Remote Branches'));

const statusText = el('span', 'status');
const spacer = el('span', 'spacer');
const refreshButton = el('button', 'icon-button', '⟳');
refreshButton.title = 'Refresh';

let filterTimer = 0;
const filters = new FilterControls({
	onChange: (filter) => {
		if (state.repo === null) return;
		state.filters[state.repo] = filter;
		persist();
		window.clearTimeout(filterTimer);
		filterTimer = window.setTimeout(applyFilterChange, FILTER_DEBOUNCE_MS);
	}
});

const fetchButton = el('button', 'icon-button filter-toggle', 'Fetch');
fetchButton.title = 'Fetch from remotes (right-click for options)';
fetchButton.addEventListener('click', () => {
	const ctx = actionContext();
	if (ctx === null || ctx.data.remotes.length === 0) return;
	void runNow(ctx, { kind: 'fetch', remote: null, prune: ctx.config.fetchAndPrune, pruneTags: ctx.config.fetchAndPrune && ctx.config.fetchAndPruneTags }, 'Fetch');
});
fetchButton.addEventListener('contextmenu', (event) => {
	event.preventDefault();
	const ctx = actionContext();
	if (ctx !== null) fetchDialog(ctx);
});

const compactButton = el('button', 'icon-button filter-toggle', 'Compact');
compactButton.title = 'Fold long runs of linear history into single rows, to see the branch structure';
compactButton.addEventListener('click', () => toggleCompact());

const searchButton = el('button', 'icon-button filter-toggle', 'Search');
searchButton.title = 'Search commits (Ctrl+F)';

toolbar.append(repoLabel, filters.branchButton, remoteLabel, spacer, statusText, fetchButton, compactButton, searchButton, filters.toggleButton, refreshButton);

/** Search state (#147). Matches are hashes in row order; `index` points at the current one. */
const search = {
	query: null as SearchQuery | null,
	matches: [] as Hash[],
	index: -1,
	history: 'idle' as SearchStatus['history'],
	error: null as string | null,
	requestId: 0,
	/** A match found in history, to jump to once the graph has loaded up to it. */
	pendingReveal: null as Hash | null
};

const searchBar = new SearchBar({
	onQuery: (text) => {
		search.query = parseQuery(text);
		search.history = 'idle';
		search.error = null;
		runSearch(false);
	},
	onNext: () => nextMatch(),
	onPrevious: () => previousMatch(),
	onSearchHistory: () => searchHistory(),
	onClose: () => {
		searchBar.close();
		search.query = null;
		runSearch(false);
		table.element.focus();
	}
});
searchButton.addEventListener('click', () => (searchBar.isOpen ? searchBar.close() : openSearch()));

const message = el('div', 'message');
message.hidden = true;

const table = new CommitTable({
	onSelect: (commit, toggle) => selectCommit(commit, toggle),
	onContextMenu: (event, commit, label) => menu.open(event.clientX, event.clientY, menuItems(commit, label)),
	onNearEnd: () => {
		if (state.config?.loadMoreCommitsAutomatically === true) loadMore();
	},
	onOpenUrl: (url) => post({ type: 'openUrl', url }),
	onLabelDoubleClick: (_commit, label) => {
		const ctx = actionContext();
		if (ctx === null || label.current) return;
		if (label.kind === 'head') void runNow(ctx, { kind: 'checkout', branch: label.name }, 'Checkout');
		else if (label.kind === 'remote') {
			const tracking = ctx.data.heads.find((h) => h.upstream === label.name);
			if (tracking !== undefined) void runNow(ctx, { kind: 'checkout', branch: tracking.name }, 'Checkout');
		}
	},
	onExpand: (hash) => {
		state.expanded.add(hash);
		drawGraph();
	},
	onScroll: () => {
		menu.close();
		persist();
	}
}, mode === 'sidebar');

const details = new DetailsPane({
	onOpenDiff: (target, change) => post({ type: 'openDiff', target, change }),
	onFileContextMenu: (event, target, change) => menu.open(event.clientX, event.clientY, fileMenuItems(target, change)),
	onRevealCommit: (hash) => revealCommit(hash),
	onClose: () => details.close(),
	onResize: (height) => {
		state.detailsHeight = height;
		persist();
	},
	onOpenUrl: (url) => post({ type: 'openUrl', url })
});
if (state.detailsHeight !== null) details.setHeight(state.detailsHeight);

const menu = new ContextMenu();
const dialog = new Dialog();
const pendingBanner = el('div', 'pending-banner');
pendingBanner.hidden = true;
document.body.classList.add(`mode-${mode}`);
if (mode === 'sidebar') {
	// The sidebar's title bar carries refresh; the toolbar keeps only the repo picker.
	remoteLabel.hidden = true;
	statusText.hidden = true;
	refreshButton.hidden = true;
	filters.branchButton.hidden = true;
	filters.toggleButton.hidden = true;
	filters.bar.hidden = true;
	searchButton.hidden = true;
	compactButton.hidden = true;
	fetchButton.hidden = true;
}
app.append(toolbar, filters.bar, searchBar.element, pendingBanner, message, table.element, details.element, menu.element, filters.popupElement, dialog.element);
if (mode === 'panel') filters.set(currentFilter());

// ---- Behaviour ------------------------------------------------------------

function showRemoteBranches(): boolean {
	return state.showRemoteBranches ?? state.config?.showRemoteBranches ?? true;
}

function loadOptions(repo: string, config: ViewConfig, maxCommits: number): LoadOptions {
	return { repo, maxCommits, showRemoteBranches: showRemoteBranches(), showTags: config.showTags, filter: currentFilter() };
}

function request(maxCommits: number): void {
	if (state.repo === null || state.config === null) return;
	const options = loadOptions(state.repo, state.config, maxCommits);
	state.loading = true;
	post({ type: 'load', options });
	render();
}

function reload(): void {
	if (state.config === null) return;
	// Keep however many commits are already on screen, so a refresh never
	// pulls the rows out from under the user's scroll position.
	request(Math.max(state.config.maxCommits, state.data?.repo.path === state.repo ? state.data.maxCommits : 0));
}

/** A new filter starts from the top with the initial page size, not the grown one. */
function applyFilterChange(): void {
	if (state.config === null) return;
	details.close();
	state.data = null;
	table.clear();
	table.scrollTop = 0;
	request(state.config.maxCommits);
}

/** Switches repository (dropping the old one's rows) and shows its own filter. */
function switchRepo(repo: string | null): void {
	state.repo = repo;
	state.data = null;
	state.error = null;
	state.loading = false;
	table.clear();
	details.close();
	search.history = 'idle';
	search.pendingReveal = null;
	if (mode === 'panel') filters.set(currentFilter());
}

// ---- Pinned branches (#207) -------------------------------------------------

function currentPins(): readonly string[] {
	return (state.repo !== null ? state.pins[state.repo] : undefined) ?? [];
}

function setPins(pins: readonly string[]): void {
	if (state.repo === null) return;
	state.pins[state.repo] = pins;
	persist();
	// Pinning is pure layout: redraw from the data already loaded.
	if (state.data !== null) showGraph(state.data);
}

// ---- Search ---------------------------------------------------------------

function openSearch(): void {
	searchBar.open();
	if (searchBar.text !== '' && search.query === null) {
		search.query = parseQuery(searchBar.text);
		runSearch(false);
	}
}

/** The refs on a commit, as the search matcher sees them. */
function searchRefs(labels: readonly RefLabel[]): SearchRef[] {
	const refs: SearchRef[] = [];
	for (const label of labels) {
		if (label.kind === 'note') continue;
		refs.push({ name: label.name, kind: label.kind === 'head' ? 'branch' : label.kind });
		// Remote branches folded into a local label are still searchable by their own name.
		for (const remote of label.remotes) refs.push({ name: `${remote}/${label.name}`, kind: 'remote' });
	}
	return refs;
}

/**
 * Re-evaluates the query against the loaded commits. `keepCurrent` keeps the
 * current match after a reload when it is still there; a match found in
 * history takes priority, since that is what the reload was for.
 */
function runSearch(keepCurrent: boolean): void {
	const data = state.data;
	const config = state.config;
	const previous = search.matches[search.index] ?? null;
	if (search.query === null || data === null || config === null) {
		search.matches = [];
		search.index = -1;
		if (state.compact) drawGraph();
		table.setSearch(null);
		updateSearchStatus();
		return;
	}
	const query = search.query;
	const labels = buildLabels(data, config);
	const useCommitDate = config.dateType === 'Commit Date';
	search.matches = data.commits
		.filter((c) => c.hash !== UNCOMMITTED && matchesQuery(query, c, searchRefs(labels.get(c.hash) ?? []), useCommitDate))
		.map((c) => c.hash);

	let index = -1;
	if (search.pendingReveal !== null && search.matches.includes(search.pendingReveal)) {
		index = search.matches.indexOf(search.pendingReveal);
		search.pendingReveal = null;
		keepCurrent = false;
	} else if (keepCurrent && previous !== null) {
		index = search.matches.indexOf(previous);
	}
	if (index === -1 && search.matches.length > 0) index = 0;
	search.index = index;
	// Matches are kept out of folded runs, so the folding depends on them.
	if (state.compact) drawGraph();
	showMatch(!keepCurrent);
}

/** Next loaded match; past the last one, the next match in history, else wrap around. */
function nextMatch(): void {
	if (search.matches.length > 0 && search.index < search.matches.length - 1) moveMatch(search.index + 1);
	else if (state.data?.moreAvailable === true && search.history !== 'exhausted') searchHistory();
	else if (search.matches.length > 0) moveMatch(0);
}

function previousMatch(): void {
	if (search.matches.length > 0) moveMatch((search.index - 1 + search.matches.length) % search.matches.length);
}

function moveMatch(index: number): void {
	search.index = index;
	showMatch(true);
}

function showMatch(scroll: boolean): void {
	const current = search.matches[search.index] ?? null;
	table.setSearch(search.query === null ? null : { matches: new Set(search.matches), current, terms: highlightTerms(search.query) });
	if (scroll && current !== null) table.scrollTo(current);
	updateSearchStatus();
}

function updateSearchStatus(): void {
	searchBar.setStatus(
		{
			current: search.index,
			total: search.matches.length,
			moreAvailable: state.data?.moreAvailable === true,
			history: search.history,
			error: search.error
		},
		search.query !== null
	);
}

/** Asks the host for the next match beyond the loaded commits. */
function searchHistory(): void {
	const data = state.data;
	if (search.query === null || data === null || state.config === null || state.repo === null || search.history === 'searching') return;
	search.history = 'searching';
	search.error = null;
	search.requestId++;
	const loaded = data.commits.filter((c) => c.hash !== UNCOMMITTED && c.stash === null).length;
	post({
		type: 'searchHistory',
		requestId: search.requestId,
		options: loadOptions(state.repo, state.config, data.maxCommits),
		query: searchBar.text,
		fromPosition: loaded
	});
	updateSearchStatus();
}

function loadMore(): void {
	if (state.loading || state.config === null || state.data === null || !state.data.moreAvailable) return;
	request(state.data.maxCommits + state.config.loadMoreCommits);
}

let selectTimer = 0;

/**
 * Reports a selection to the host, which loads its files into the Changes view
 * and answers with them for the details pane. Clicking the row whose details
 * are already open closes them instead.
 */
function selectCommit(commit: Commit, toggle: boolean): void {
	if (state.repo === null) return;
	if (mode === 'panel' && details.currentHash === commit.hash) {
		if (toggle) details.close();
		return;
	}
	const repo = state.repo;
	if (mode === 'panel') {
		details.open(repo, commit, labelsFor(commit), state.data?.issueLinks ?? []);
	}
	window.clearTimeout(selectTimer);
	selectTimer = window.setTimeout(() => {
		const title = commit.hash === UNCOMMITTED ? commit.subject : `${shortHash(commit.hash)} ${commit.subject}`;
		post({ type: 'selectCommit', target: changeTarget(repo, commit), title, hasNote: hasNote(commit.hash) });
	}, SELECT_DEBOUNCE_MS);
}

function hasNote(hash: Hash): boolean {
	return state.data?.notedCommits.includes(hash) === true;
}

function labelsFor(commit: Commit): RefLabel[] {
	return state.data !== null && state.config !== null ? (buildLabels(state.data, state.config).get(commit.hash) ?? []) : [];
}

function fileMenuItems(target: ChangeTarget, change: FileChange): MenuItem[] {
	const items: MenuItem[] = [{ label: 'Open Changes', action: () => post({ type: 'openDiff', target, change }) }];
	if (change.type !== FileChangeType.Deleted) {
		items.push({ label: 'Open File', action: () => post({ type: 'openFile', repo: target.repo, path: change.path }) });
	}
	items.push(
		{ separator: true },
		{ label: 'Copy Relative Path', action: () => post({ type: 'copyToClipboard', text: change.path, label: 'path' }) }
	);
	return items;
}

/** Appends a group of items, separated from what came before. */
function group(items: MenuItem[], next: readonly MenuItem[]): void {
	if (next.length === 0) return;
	if (items.length > 0 && !('separator' in items[items.length - 1])) items.push({ separator: true });
	items.push(...next);
}

/**
 * The context menu. On a label: what can be done with that ref (git
 * actions, then view options, then copying). On a row: the commit's actions.
 */
function menuItems(commit: Commit, label: RefLabel | null): MenuItem[] {
	const run = state.runs.get(commit.hash);
	if (run !== undefined) {
		return [
			{ label: `Expand ${run.length} Commits`, action: () => { state.expanded.add(commit.hash); drawGraph(); } },
			{ label: 'Show Full History (Leave Compact Mode)', action: () => toggleCompact() }
		];
	}
	const copy = (text: string, what: string) => () => post({ type: 'copyToClipboard', text, label: what });
	const ctx = actionContext();
	const items: MenuItem[] = [];

	if (label !== null && label.kind !== 'note') {
		if (ctx !== null) group(items, labelActions(ctx, label, commit));

		const view: MenuItem[] = [];
		if (label.kind === 'head' || label.kind === 'remote') {
			const ref = label.kind === 'head' ? `refs/heads/${label.name}` : `refs/remotes/${label.name}`;
			if (mode === 'panel') view.push({ label: 'Show Only This Branch', action: () => filters.update({ branches: [ref] }) });
			const pinnedBySetting = state.config?.pinnedBranches.some((pattern) => globMatches(pattern, label.name)) === true;
			if (currentPins().includes(label.name)) view.push({ label: 'Unpin from Own Column', action: () => setPins(currentPins().filter((n) => n !== label.name)) });
			else if (!pinnedBySetting) view.push({ label: 'Pin to Own Column', action: () => setPins([...currentPins(), label.name]) });
		}
		if (mode === 'panel' && label.kind === 'tag') {
			view.push({ label: 'Show Only This Tag', action: () => filters.update({ branches: [`refs/tags/${label.name}`] }) });
		}
		if (mode === 'panel' && (label.kind === 'head' || label.kind === 'remote' || label.kind === 'tag') && !label.current) {
			const what = label.kind === 'tag' ? 'Tag' : 'Branch';
			view.push({ label: `Hide This ${what}`, action: () => filters.update({ excludes: [...currentFilter().excludes, escapeGlob(label.name)] }) });
		}
		group(items, view);

		const what = { head: 'Branch Name', remote: 'Branch Name', tag: 'Tag Name', stash: 'Stash Name' }[label.kind];
		group(items, [{ label: `Copy ${what}`, action: copy(label.name, what.toLowerCase()) }]);
		return items;
	}

	if (ctx !== null) group(items, commitActions(ctx, commit));
	if (commit.hash === UNCOMMITTED) {
		group(items, [{ label: 'Copy Summary', action: copy(commit.subject, 'summary') }]);
		return items;
	}
	if (mode === 'panel' && commit.stash === null && commit.author !== '') {
		const current = currentFilter().authors;
		if (!current.includes(commit.author)) {
			group(items, [{ label: `Filter by Author "${commit.author}"`, action: () => filters.update({ authors: [...current, commit.author] }) }]);
		}
	}
	group(items, [
		{ label: 'Copy Commit Hash', action: copy(commit.hash, 'commit hash') },
		{ label: 'Copy Short Hash', action: copy(commit.hash.slice(0, 8), 'short hash') },
		{ label: 'Copy Commit Subject', action: copy(commit.subject, 'commit subject') }
	]);
	return items;
}

// ---- Actions (Phase 3) ------------------------------------------------------

let actionRequests = 0;
const actionReplies = new Map<number, (error: string | null) => void>();

/** Sends an action to the host and resolves with its outcome. */
function runAction(repo: string, action: GitAction): Promise<string | null> {
	const requestId = ++actionRequests;
	return new Promise((resolve) => {
		actionReplies.set(requestId, resolve);
		post({ type: 'runAction', requestId, repo, action });
	});
}

function actionContext(): ActionContext | null {
	const data = state.data;
	const config = state.config;
	const repo = state.repo;
	if (data === null || config === null || repo === null || data.repo.path !== repo) return null;
	return { data, config, dialog, run: (action) => runAction(repo, action) };
}

/** The banner for an interrupted merge, rebase, cherry-pick, revert or bisect (#519). */
function renderPendingBanner(): void {
	const data = state.data;
	const ctx = actionContext();
	const operation = data?.repo.pendingOperation ?? null;
	if (ctx === null || operation === null) {
		pendingBanner.hidden = true;
		return;
	}
	const noun = { merge: 'A merge', rebase: 'A rebase', 'cherry-pick': 'A cherry-pick', revert: 'A revert', bisect: 'A bisect' }[operation];
	const hint = operation === 'bisect' ? '' : ' Resolve any conflicts and stage the files, then continue — or abort to go back.';
	const { continue: resume, abort } = pendingOperationActions(ctx, operation);
	const buttons: HTMLElement[] = [];
	if (resume !== null) {
		const button = el('button', 'banner-button', 'Continue');
		button.addEventListener('click', resume);
		buttons.push(button);
	}
	const abortButton = el('button', 'banner-button secondary', 'Abort');
	abortButton.addEventListener('click', abort);
	buttons.push(abortButton);
	pendingBanner.replaceChildren(el('span', 'banner-text', `${noun} is in progress.${hint}`), ...buttons);
	pendingBanner.hidden = false;
}

// ---- Rendering ------------------------------------------------------------

function renderRepos(): void {
	repoSelect.replaceChildren(
		...state.repos.map((repo) => {
			const option = el('option', '', repo.name);
			option.value = repo.path;
			option.title = repo.path;
			return option;
		})
	);
	if (state.repo !== null) repoSelect.value = state.repo;
	repoLabel.hidden = state.repos.length <= 1;
	toolbar.hidden = mode === 'sidebar' && repoLabel.hidden;
}

function render(): void {
	remoteCheckbox.checked = showRemoteBranches();

	const data = state.data !== null && state.data.repo.path === state.repo ? state.data : null;
	let text = '';
	if (state.loading) text = 'Loading…';
	else if (data !== null) {
		const count = data.commits.filter((c) => c.hash !== UNCOMMITTED && c.stash === null).length;
		const head = data.repo.isDetached ? 'detached HEAD' : data.repo.head;
		text = `${count}${data.moreAvailable ? '+' : ''} commits${isFiltered(currentFilter()) ? ' (filtered)' : ''} · ${head ?? ''}`;
		if (data.repo.pendingOperation !== null) text += ` · ${data.repo.pendingOperation} in progress`;
	}
	statusText.textContent = text;

	let note: string | null = null;
	if (state.repos.length === 0 && state.config !== null) {
		note = 'No Git repositories were found in this workspace. Open a folder containing a repository, or run "Git Graph Next: Add Git Repository...".';
	} else if (state.error !== null) {
		note = state.error;
	} else if (data !== null && data.commits.length === 0) {
		note = isFiltered(currentFilter()) ? 'No commits match the current filter.' : 'This repository has no commits yet.';
	}
	message.textContent = note ?? '';
	message.hidden = note === null;
	message.classList.toggle('error', state.error !== null);
	table.element.hidden = data === null || data.commits.length === 0;

	const footer = table.footerElement;
	footer.replaceChildren();
	if (data !== null && data.moreAvailable) {
		const button = el('button', 'load-more', state.loading ? 'Loading…' : 'Load More Commits');
		button.disabled = state.loading;
		button.addEventListener('click', loadMore);
		footer.appendChild(button);
	}
}

function showGraph(data: GraphData): void {
	const config = state.config;
	if (config === null) return;
	const switchedRepo = state.data?.repo.path !== data.repo.path;
	if (switchedRepo) state.expanded.clear();
	state.data = data;
	if (mode === 'panel') {
		let known = state.authors.get(data.repo.path);
		if (known === undefined) state.authors.set(data.repo.path, (known = new Set()));
		for (const commit of data.commits) if (commit.hash !== UNCOMMITTED && commit.stash === null) known.add(commit.author);
		filters.setData(data, [...known].sort((a, b) => a.localeCompare(b)));
	}
	// Unhide before measuring: a hidden element has no size and ignores scrollTop.
	table.element.hidden = data.commits.length === 0;
	drawGraph();
	syncDetails(data);
	renderPendingBanner();
	if (search.query !== null) runSearch(true);
	if (state.restoreScrollTop !== null) {
		table.scrollTop = state.restoreScrollTop;
		state.restoreScrollTop = null;
	} else if (switchedRepo) {
		table.scrollTop = 0;
	}
}

/**
 * Lays out and draws the loaded data: folded into compact form when that mode
 * is on, with pinned columns (#207) and fixed branch colours (#254).
 */
function drawGraph(): void {
	const data = state.data;
	const config = state.config;
	if (data === null || config === null) return;

	let shown = data;
	state.runs = new Map();
	if (state.compact) {
		// Everything that gives the graph its shape, or that the user is
		// looking at, stays a row of its own.
		const keep = new Set<Hash>([...buildLabels(data, config).keys(), ...search.matches]);
		if (data.repo.headHash !== null) keep.add(data.repo.headHash);
		for (const hash of [details.currentHash, table.selectedHash]) if (hash !== null) keep.add(hash);
		const view = collapseRuns(data.commits, keep, state.expanded);
		shown = { ...data, commits: view.commits };
		state.runs = view.runs;
	}

	const { palette, laneColours } = resolveBranchColours(shown, config.colours, config.branchColours);
	const layout = layoutGraph(shown.commits, {
		colourCount: config.colours.length,
		uncommittedHash: UNCOMMITTED,
		pinnedBranches: resolvePins(shown, [...config.pinnedBranches, ...currentPins()]),
		laneColours
	});
	table.setData(shown, layout, { ...config, colours: palette }, state.runs);
	compactButton.classList.toggle('active', state.compact);
}

function toggleCompact(): void {
	state.compact = !state.compact;
	state.expanded.clear();
	persist();
	drawGraph();
	if (search.query !== null) showMatch(false);
}

/** Scrolls to a commit, first expanding the collapsed run it is folded into. */
function revealCommit(hash: Hash): void {
	if (table.reveal(hash)) return;
	const run = runContaining(state.runs, hash);
	if (run === null) return;
	state.expanded.add(run);
	drawGraph();
	table.reveal(hash);
}

/**
 * After a reload, the open details must still describe something on screen:
 * a commit that vanished (amended, rebased away) closes the pane, and the
 * Uncommitted Changes row, whose files change constantly, is re-read.
 */
function syncDetails(data: GraphData): void {
	const hash = details.currentHash;
	if (hash === null) return;
	const commit = data.commits.find((c) => c.hash === hash);
	if (commit === undefined) {
		details.close();
	} else if (hash === UNCOMMITTED) {
		details.open(data.repo.path, commit, []);
		post({ type: 'selectCommit', target: changeTarget(data.repo.path, commit), title: commit.subject, hasNote: false });
	}
}

// ---- Messages -------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
	const msg = event.data;
	switch (msg.type) {
		case 'config': {
			const first = state.config === null;
			state.config = msg.config;
			if (!first && state.data !== null) showGraph(state.data);
			break;
		}
		case 'repos': {
			state.repos = msg.repos;
			const switched = msg.selected !== state.repo;
			if (switched) {
				// The remembered scroll position belongs to the remembered repository only.
				if (msg.selected !== saved?.repo) state.restoreScrollTop = null;
				switchRepo(msg.selected);
			}
			renderRepos();
			persist();
			if (state.repo !== null && (switched || (state.data === null && !state.loading))) reload();
			break;
		}
		case 'toggleCompact':
			toggleCompact();
			return;
		case 'setFilter': {
			if (mode !== 'panel') return;
			if (msg.repo !== state.repo) {
				state.restoreScrollTop = null;
				switchRepo(msg.repo);
				renderRepos();
			}
			const filter = { ...currentFilter(), ...msg.filter };
			state.filters[msg.repo] = filter;
			filters.set(filter);
			persist();
			applyFilterChange();
			break;
		}
		case 'loading':
			if (msg.repo === state.repo) state.loading = true;
			break;
		case 'graph':
			if (msg.data.repo.path !== state.repo) return;
			state.loading = false;
			state.error = null;
			showGraph(msg.data);
			break;
		case 'searchResult': {
			if (msg.requestId !== search.requestId) return;
			if (msg.error !== null) {
				search.history = 'error';
				search.error = msg.error;
			} else if (msg.match === null) {
				search.history = 'exhausted';
			} else if (state.data !== null && state.config !== null) {
				search.history = 'idle';
				search.pendingReveal = msg.match.hash;
				// Load past the match, with a page to spare so it is not the last row.
				request(Math.max(state.data.maxCommits, msg.match.position + 1 + state.config.loadMoreCommits));
			}
			updateSearchStatus();
			return;
		}
		case 'actionResult': {
			const reply = actionReplies.get(msg.requestId);
			actionReplies.delete(msg.requestId);
			reply?.(msg.error);
			return;
		}
		case 'runFetch': {
			const ctx = actionContext();
			if (ctx !== null) fetchDialog(ctx);
			return;
		}
		case 'changes':
			if (msg.repo !== state.repo) return;
			details.showChanges(msg.hash, msg.changes, msg.error);
			if (msg.note !== null) details.showNote(msg.hash, msg.note);
			return;
		case 'error':
			if (msg.repo !== null && msg.repo !== state.repo) return;
			state.loading = false;
			state.error = msg.message;
			break;
	}
	render();
});

repoSelect.addEventListener('change', () => {
	state.restoreScrollTop = null;
	switchRepo(repoSelect.value);
	persist();
	reload();
});

document.addEventListener('keydown', (event) => {
	if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
		event.preventDefault();
		openSearch();
		return;
	}
	if (event.key === 'F3' && searchBar.isOpen) {
		event.preventDefault();
		searchBar.flush();
		if (event.shiftKey) previousMatch();
		else nextMatch();
		return;
	}
	if (event.key === 'Escape' && details.isOpen) details.close();
});

remoteCheckbox.addEventListener('change', () => {
	state.showRemoteBranches = remoteCheckbox.checked;
	persist();
	reload();
});

refreshButton.addEventListener('click', reload);

render();
post({ type: 'ready', repo: state.repo });
