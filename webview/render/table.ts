import { UNCOMMITTED, type Commit, type GraphData, type GraphLayout, type Hash } from '../../src/types.ts';
import type { ViewConfig } from '../../src/view/protocol.ts';
import { formatDate, formatDateLong, shortHash } from '../format.ts';
import { DEFAULT_GEOMETRY, graphPixelWidth, renderGraph, type GraphGeometry } from './graph.ts';

/** Rows rendered above and below the viewport, so fast scrolling shows no gaps. */
const OVERSCAN = 15;
/** Minimum width of the graph column, so the header text always fits. */
const MIN_GRAPH_WIDTH = 64;
/** Rows from the bottom at which more commits are requested. */
const LOAD_MORE_THRESHOLD = 10;

export type LabelKind = 'head' | 'remote' | 'tag' | 'stash';

export interface RefLabel {
	readonly kind: LabelKind;
	readonly name: string;
	/** Remotes whose same-named branch is at the same commit, shown folded into a local label. */
	readonly remotes: readonly string[];
	/** The checked-out branch. */
	readonly current: boolean;
	readonly title: string;
}

/**
 * Groups every ref by the commit it points at, ready to draw as labels.
 *
 * When enabled, a remote branch at the same commit as the local branch of the
 * same name is folded into the local label (`main  origin`) rather than drawn
 * as a second label, which is most of the clutter on a typical graph.
 */
export function buildLabels(data: GraphData, config: Pick<ViewConfig, 'combineLocalAndRemoteBranchLabels' | 'showRemoteHeads'>): Map<Hash, RefLabel[]> {
	const labels = new Map<Hash, RefLabel[]>();
	const add = (hash: Hash, label: RefLabel) => {
		const list = labels.get(hash);
		if (list === undefined) labels.set(hash, [label]);
		else list.push(label);
	};

	// `origin` → `origin/main`, inverted so a label can say it is its remote's HEAD.
	const remoteDefault = new Set(Object.values(data.remoteHeadSymrefs));
	const folded = new Set<string>();

	for (const head of data.heads) {
		const remotes: string[] = [];
		if (config.combineLocalAndRemoteBranchLabels) {
			for (const remote of data.remoteHeads) {
				if (remote.hash === head.hash && remote.name === `${remote.remote}/${head.name}`) {
					remotes.push(remote.remote);
					folded.add(remote.name);
				}
			}
		}
		const current = data.repo.head === head.name;
		let title = `Branch ${head.name}`;
		if (head.upstream !== null) {
			title += `\nTracks ${head.upstream}`;
			if (head.ahead !== null && head.behind !== null && (head.ahead > 0 || head.behind > 0)) {
				title += ` (${head.ahead} ahead, ${head.behind} behind)`;
			}
		}
		if (current) title += '\nChecked out';
		add(head.hash, { kind: 'head', name: head.name, remotes, current, title });
	}

	for (const remote of data.remoteHeads) {
		if (folded.has(remote.name)) continue;
		const isDefault = config.showRemoteHeads && remoteDefault.has(remote.name);
		const title = `Remote branch ${remote.name}${isDefault ? `\nDefault branch of ${remote.remote} (${remote.remote}/HEAD)` : ''}`;
		add(remote.hash, { kind: 'remote', name: remote.name, remotes: [], current: false, title });
	}

	for (const tag of data.tags) {
		add(tag.hash, { kind: 'tag', name: tag.name, remotes: [], current: false, title: `${tag.annotated ? 'Annotated tag' : 'Tag'} ${tag.name}` });
	}

	for (const commit of data.commits) {
		if (commit.stash !== null) {
			add(commit.hash, { kind: 'stash', name: commit.stash.selector, remotes: [], current: false, title: `Stash ${commit.stash.selector}` });
		}
	}

	const rank = (label: RefLabel) => (label.current ? 0 : { head: 1, remote: 2, tag: 3, stash: 4 }[label.kind]);
	for (const list of labels.values()) list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	return labels;
}

export interface TableCallbacks {
	/** `toggle` is true for a plain click, which may close details already open for the row. */
	onSelect(commit: Commit, toggle: boolean): void;
	onContextMenu(event: MouseEvent, commit: Commit, label: RefLabel | null): void;
	onNearEnd(): void;
	onScroll(scrollTop: number): void;
}

interface TableModel {
	readonly data: GraphData;
	readonly layout: GraphLayout;
	readonly config: ViewConfig;
	readonly labels: Map<Hash, RefLabel[]>;
	readonly stashHashes: Set<Hash>;
	readonly colourOf: (row: number) => string;
}

/**
 * The commit table. Only the rows in (and just around) the viewport exist in
 * the DOM, and the graph is redrawn for exactly those rows, so a history of
 * 100k commits costs the same per frame as one of 100.
 */
export class CommitTable {
	readonly element: HTMLElement;
	private readonly header: HTMLElement;
	private readonly body: HTMLElement;
	private readonly rowsLayer: HTMLElement;
	private readonly svg: SVGSVGElement;
	private readonly footer: HTMLElement;

	private model: TableModel | null = null;
	private geometry: GraphGeometry = DEFAULT_GEOMETRY;
	private selected: Hash | null = null;
	/** The window currently in the DOM, to skip redundant redraws while scrolling. */
	private drawn: { first: number; last: number } | null = null;
	private frame = 0;

	/**
	 * @param compact Sidebar mode: only the graph and description columns, with
	 * the author, date and hash moved into the row tooltip.
	 */
	constructor(
		private readonly callbacks: TableCallbacks,
		private readonly compact = false
	) {
		this.element = el('div', compact ? 'table compact' : 'table');
		this.element.tabIndex = 0;

		this.header = el('div', 'row header');
		for (const [cls, text] of [['graph', 'Graph'], ['desc', 'Description'], ['date', 'Date'], ['author', 'Author'], ['hash', 'Commit']]) {
			this.header.appendChild(el('div', `cell ${cls}`, text));
		}

		this.body = el('div', 'body');
		this.rowsLayer = el('div', 'rows');
		this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this.svg.classList.add('graph-svg');
		this.body.append(this.rowsLayer, this.svg);
		this.footer = el('div', 'footer');

		this.element.append(this.header, this.body, this.footer);

		this.element.addEventListener('scroll', () => {
			this.scheduleDraw();
			this.callbacks.onScroll(this.element.scrollTop);
		});
		new ResizeObserver(() => this.scheduleDraw()).observe(this.element);
		this.rowsLayer.addEventListener('click', (event) => this.onRowEvent(event, false));
		this.rowsLayer.addEventListener('contextmenu', (event) => this.onRowEvent(event, true));
		this.element.addEventListener('keydown', (event) => this.onKey(event));
	}

	get scrollTop(): number {
		return this.element.scrollTop;
	}

	set scrollTop(value: number) {
		this.element.scrollTop = value;
		this.scheduleDraw();
	}

	get footerElement(): HTMLElement {
		return this.footer;
	}

	get selectedHash(): Hash | null {
		return this.selected;
	}

	/** Selects a commit and scrolls it into view. Returns false when it is not loaded. */
	reveal(hash: Hash): boolean {
		const index = this.model?.data.commits.findIndex((c) => c.hash === hash) ?? -1;
		if (index === -1) return false;
		this.select(hash);
		this.scrollRowIntoView(index);
		return true;
	}

	setData(data: GraphData, layout: GraphLayout, config: ViewConfig): void {
		this.geometry = { ...DEFAULT_GEOMETRY, style: config.graphStyle };
		const colours = config.colours.length > 0 ? config.colours : ['#888'];
		this.model = {
			data,
			layout,
			config,
			labels: buildLabels(data, config),
			stashHashes: new Set(data.commits.filter((c) => c.stash !== null).map((c) => c.hash)),
			colourOf: (row) => colours[layout.vertices[row].colour % colours.length]
		};
		if (this.selected !== null && !data.commits.some((c) => c.hash === this.selected)) this.selected = null;

		const graphWidth = Math.max(MIN_GRAPH_WIDTH, graphPixelWidth(layout, this.geometry));
		this.element.style.setProperty('--graph-width', `${graphWidth}px`);
		this.element.style.setProperty('--row-height', `${this.geometry.rowHeight}px`);
		this.element.classList.toggle('sticky', config.stickyHeader);
		this.body.style.height = `${data.commits.length * this.geometry.rowHeight}px`;

		this.drawn = null;
		this.draw();
	}

	clear(): void {
		this.model = null;
		this.drawn = null;
		this.rowsLayer.replaceChildren();
		this.svg.replaceChildren();
		this.body.style.height = '0px';
	}

	private scheduleDraw(): void {
		if (this.frame !== 0) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = 0;
			this.draw();
		});
	}

	private visibleWindow(rowCount: number): { first: number; last: number } {
		const h = this.geometry.rowHeight;
		// The body starts below the header; scroll offsets are relative to the table.
		const top = Math.max(0, this.element.scrollTop - this.body.offsetTop);
		const first = Math.max(0, Math.floor(top / h) - OVERSCAN);
		const last = Math.min(rowCount - 1, Math.ceil((top + this.element.clientHeight) / h) + OVERSCAN);
		return { first, last };
	}

	private draw(): void {
		const model = this.model;
		if (model === null) return;
		const rowCount = model.data.commits.length;
		if (rowCount === 0) {
			this.rowsLayer.replaceChildren();
			this.svg.replaceChildren();
			return;
		}

		const range = this.visibleWindow(rowCount);
		if (this.drawn !== null && this.drawn.first === range.first && this.drawn.last === range.last) return;
		this.drawn = range;

		const h = this.geometry.rowHeight;
		const offset = `${range.first * h}px`;
		this.rowsLayer.style.top = offset;
		this.svg.style.top = offset;

		const fragment = document.createDocumentFragment();
		for (let row = range.first; row <= range.last; row++) fragment.appendChild(this.renderRow(model, row));
		this.rowsLayer.replaceChildren(fragment);

		renderGraph(this.svg, {
			layout: model.layout,
			geometry: this.geometry,
			colours: model.config.colours,
			rowCount,
			first: range.first,
			last: range.last,
			headHash: model.data.repo.headHash,
			uncommittedHash: UNCOMMITTED,
			stashHashes: model.stashHashes
		});

		if (range.last >= rowCount - LOAD_MORE_THRESHOLD) this.callbacks.onNearEnd();
	}

	private renderRow(model: TableModel, row: number): HTMLElement {
		const commit = model.data.commits[row];
		const element = el('div', 'row commit');
		element.dataset.row = String(row);
		if (commit.hash === this.selected) element.classList.add('selected');
		if (commit.hash === UNCOMMITTED) element.classList.add('uncommitted');
		if (commit.hash === model.data.repo.headHash) element.classList.add('head');

		element.appendChild(el('div', 'cell graph'));

		const desc = el('div', 'cell desc');
		const colour = model.colourOf(row);
		for (const label of model.labels.get(commit.hash) ?? []) {
			const tag = el('span', `label ${label.kind}${label.current ? ' current' : ''}`);
			tag.title = label.title;
			tag.style.setProperty('--label-colour', colour);
			tag.dataset.label = label.name;
			tag.appendChild(el('span', 'name', label.name));
			for (const remote of label.remotes) {
				const part = el('span', 'remote', remote);
				part.title = `${remote}/${label.name} is at the same commit`;
				tag.appendChild(part);
			}
			desc.appendChild(tag);
		}
		const subject = el('span', 'subject', commit.subject);
		subject.title = commit.body === '' ? commit.subject : `${commit.subject}\n\n${commit.body}`;
		if (this.compact && commit.hash !== UNCOMMITTED) {
			const when = formatDate(model.config.dateType === 'Commit Date' ? commit.committerDate : commit.authorDate, model.config.dateFormat);
			const who = commit.stash !== null ? commit.stash.selector : commit.author;
			subject.title = `${shortHash(commit.hash)} · ${who} · ${when}\n\n${subject.title}`;
		}
		desc.appendChild(subject);
		element.appendChild(desc);

		const seconds = model.config.dateType === 'Commit Date' ? commit.committerDate : commit.authorDate;
		const date = el('div', 'cell date', commit.hash === UNCOMMITTED ? '' : formatDate(seconds, model.config.dateFormat));
		date.title = commit.hash === UNCOMMITTED ? '' : formatDateLong(seconds);
		element.appendChild(date);

		const authorText = commit.hash === UNCOMMITTED || commit.stash !== null ? '' : commit.author;
		const author = el('div', 'cell author', authorText);
		if (authorText !== '') author.title = `${commit.author} <${commit.authorEmail}>`;
		element.appendChild(author);

		const hash = el('div', 'cell hash', commit.hash === UNCOMMITTED ? '' : shortHash(commit.hash));
		if (commit.hash !== UNCOMMITTED) hash.title = commit.hash;
		element.appendChild(hash);

		return element;
	}

	private rowFromEvent(event: Event): { row: number; commit: Commit; label: RefLabel | null } | null {
		const target = event.target as HTMLElement | null;
		const rowElement = target?.closest<HTMLElement>('.row.commit');
		if (rowElement == null || this.model === null) return null;
		const row = Number(rowElement.dataset.row);
		const commit = this.model.data.commits[row];
		if (commit === undefined) return null;
		const labelName = target?.closest<HTMLElement>('.label')?.dataset.label;
		const label = labelName !== undefined ? (this.model.labels.get(commit.hash) ?? []).find((l) => l.name === labelName) ?? null : null;
		return { row, commit, label };
	}

	private onRowEvent(event: MouseEvent, context: boolean): void {
		const hit = this.rowFromEvent(event);
		if (hit === null) return;
		// Right-clicking the selected row must not re-select it: that would toggle its details shut.
		if (!context || hit.commit.hash !== this.selected) this.select(hit.commit.hash, !context);
		if (context) {
			event.preventDefault();
			this.callbacks.onContextMenu(event, hit.commit, hit.label);
		}
	}

	private select(hash: Hash, toggle = false): void {
		if (this.model === null) return;
		this.selected = hash;
		for (const row of this.rowsLayer.children) {
			const index = Number((row as HTMLElement).dataset.row);
			row.classList.toggle('selected', this.model.data.commits[index]?.hash === hash);
		}
		const commit = this.model.data.commits.find((c) => c.hash === hash);
		if (commit !== undefined) this.callbacks.onSelect(commit, toggle);
	}

	private onKey(event: KeyboardEvent): void {
		if (this.model === null || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
		const commits = this.model.data.commits;
		const current = commits.findIndex((c) => c.hash === this.selected);
		const next = current === -1 ? 0 : Math.max(0, Math.min(commits.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
		if (commits[next] === undefined) return;
		event.preventDefault();
		this.select(commits[next].hash);
		this.scrollRowIntoView(next);
	}

	/** Scrolls the least distance that shows a row fully, below the sticky header. */
	private scrollRowIntoView(next: number): void {
		const h = this.geometry.rowHeight;
		const rowTop = this.body.offsetTop + next * h;
		const viewTop = this.element.scrollTop + this.header.offsetHeight;
		const viewBottom = this.element.scrollTop + this.element.clientHeight;
		if (rowTop < viewTop) this.element.scrollTop = rowTop - this.header.offsetHeight;
		else if (rowTop + h > viewBottom) this.element.scrollTop = rowTop + h - this.element.clientHeight;
		this.drawn = null;
		this.scheduleDraw();
	}
}

/** Creates an element; text goes through textContent, never HTML, so commit content cannot inject markup. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (className !== '') element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}
