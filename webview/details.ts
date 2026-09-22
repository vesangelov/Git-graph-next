import { FileChangeType, UNCOMMITTED, type ChangeTarget, type Commit, type FileChange, type Hash } from '../src/types.ts';
import { formatDateLong, shortHash } from './format.ts';
import { appendMessage, el, type RefLabel } from './render/table.ts';
import type { IssueLinkRule } from '../src/git/remote.ts';

/** Smallest height the pane can be dragged to, and the share of the view it may take at most. */
const MIN_HEIGHT = 120;
const MAX_FRACTION = 0.8;

export interface DetailsCallbacks {
	onOpenDiff(target: ChangeTarget, change: FileChange): void;
	onFileContextMenu(event: MouseEvent, target: ChangeTarget, change: FileChange): void;
	onRevealCommit(hash: Hash): void;
	onClose(): void;
	onResize(height: number): void;
	onOpenUrl(url: string): void;
}

const STATUS_NAMES: Record<FileChangeType, string> = {
	[FileChangeType.Added]: 'Added',
	[FileChangeType.Modified]: 'Modified',
	[FileChangeType.Deleted]: 'Deleted',
	[FileChangeType.Renamed]: 'Renamed',
	[FileChangeType.Untracked]: 'Untracked'
};

/** The comparison a row's details show: a commit against its first parent. */
export function changeTarget(repo: string, commit: Commit): ChangeTarget {
	return { repo, hash: commit.hash, base: commit.parents[0] ?? null };
}

/**
 * The commit details pane under the graph: who, when, the full message, and
 * the changed files, each of which opens a diff.
 */
export class DetailsPane {
	readonly element: HTMLElement;
	private readonly title: HTMLElement;
	private readonly meta: HTMLElement;
	private readonly files: HTMLElement;

	private target: ChangeTarget | null = null;
	private links: readonly IssueLinkRule[] = [];

	constructor(private readonly callbacks: DetailsCallbacks) {
		this.element = el('div', 'details');
		this.element.hidden = true;

		const handle = el('div', 'resize-handle');
		handle.title = 'Drag to resize';
		this.installResize(handle);

		const header = el('div', 'details-header');
		this.title = el('span', 'details-title');
		const close = el('button', 'icon-button', '×');
		close.title = 'Close (Escape)';
		close.addEventListener('click', () => this.callbacks.onClose());
		header.append(this.title, close);

		const content = el('div', 'details-content');
		this.meta = el('div', 'details-meta');
		this.files = el('div', 'details-files');
		content.append(this.meta, this.files);

		this.element.append(handle, header, content);
		this.meta.addEventListener('click', (event) => {
			const url = (event.target as HTMLElement | null)?.closest<HTMLElement>('a.issue-link')?.dataset.url;
			if (url !== undefined) this.callbacks.onOpenUrl(url);
		});
	}

	get isOpen(): boolean {
		return !this.element.hidden;
	}

	get currentHash(): Hash | null {
		return this.isOpen ? (this.target?.hash ?? null) : null;
	}

	setHeight(height: number): void {
		this.element.style.height = `${Math.max(MIN_HEIGHT, height)}px`;
	}

	/** Shows a commit; its files arrive later through `showChanges`. */
	open(repo: string, commit: Commit, labels: readonly RefLabel[], links: readonly IssueLinkRule[] = []): void {
		this.links = links;
		this.target = changeTarget(repo, commit);
		this.element.hidden = false;
		this.title.textContent = commit.hash === UNCOMMITTED ? commit.subject : `${shortHash(commit.hash)}  ${commit.subject}`;
		this.title.title = this.title.textContent;
		this.renderMeta(commit, labels);
		this.files.replaceChildren(el('div', 'details-note', 'Loading changed files…'));
	}

	/** Adds a commit's git note (#475) under its message. */
	showNote(hash: Hash, note: string): void {
		if (this.target?.hash !== hash) return;
		const block = el('div', 'details-notes');
		block.append(el('div', 'details-notes-title', 'Notes'), el('div', 'details-message selectable', note));
		this.meta.appendChild(block);
	}

	close(): void {
		this.element.hidden = true;
		this.target = null;
	}

	/** Shows a commit's files, unless the pane has since moved to another commit. */
	showChanges(hash: Hash, changes: readonly FileChange[] | null, error: string | null): void {
		const target = this.target;
		if (target === null || target.hash !== hash) return;
		if (changes === null) {
			this.files.replaceChildren(el('div', 'details-note error', error ?? 'Could not load the changed files.'));
			return;
		}

		let additions = 0;
		let deletions = 0;
		for (const change of changes) {
			additions += change.additions ?? 0;
			deletions += change.deletions ?? 0;
		}
		const summary = el('div', 'details-summary');
		summary.append(
			el('span', '', `${changes.length} file${changes.length === 1 ? '' : 's'} changed`),
			el('span', 'additions', `+${additions}`),
			el('span', 'deletions', `−${deletions}`)
		);
		const list = el('div', 'file-list');
		for (const change of changes) list.appendChild(this.renderFile(target, change));
		this.files.replaceChildren(summary, list);
	}

	private renderMeta(commit: Commit, labels: readonly RefLabel[]): void {
		const rows: [string, HTMLElement | string][] = [];

		if (commit.hash === UNCOMMITTED) {
			rows.push(['Against', commit.parents[0] !== undefined ? this.commitLink(commit.parents[0]) : 'nothing']);
			this.meta.replaceChildren(this.table(rows), el('div', 'details-message', 'Changes in the index and working tree, compared with HEAD.'));
			return;
		}

		rows.push(['Commit', el('span', 'mono selectable', commit.hash)]);
		if (commit.stash !== null) {
			rows.push(['Stash', commit.stash.selector]);
			rows.push(['Based on', this.commitLink(commit.stash.baseHash)]);
		} else {
			const parents = el('span');
			if (commit.parents.length === 0) parents.textContent = 'none (root commit)';
			commit.parents.forEach((parent, i) => {
				if (i > 0) parents.append(', ');
				parents.appendChild(this.commitLink(parent));
			});
			rows.push([commit.parents.length > 1 ? 'Parents' : 'Parent', parents]);
			rows.push(['Author', `${commit.author} <${commit.authorEmail}>`]);
			rows.push(['Authored', formatDateLong(commit.authorDate)]);
			if (commit.committer !== commit.author || commit.committerEmail !== commit.authorEmail) {
				rows.push(['Committer', `${commit.committer} <${commit.committerEmail}>`]);
			}
			if (commit.committerDate !== commit.authorDate) rows.push(['Committed', formatDateLong(commit.committerDate)]);
		}
		const refs = labels.filter((l) => l.kind !== 'note');
		if (refs.length > 0) rows.push(['Refs', refs.map((l) => l.name).join(', ')]);
		if (commit.parents.length > 1) rows.push(['Diff', 'Changes are shown against the first parent.']);

		const message = el('div', 'details-message selectable');
		appendMessage(message, commit.body === '' ? commit.subject : `${commit.subject}\n\n${commit.body}`, [], this.links);
		this.meta.replaceChildren(this.table(rows), message);
	}

	private table(rows: readonly [string, HTMLElement | string][]): HTMLElement {
		const table = el('div', 'meta-table');
		for (const [key, value] of rows) {
			table.appendChild(el('div', 'meta-key', key));
			const cell = el('div', 'meta-value');
			if (typeof value === 'string') cell.textContent = value;
			else cell.appendChild(value);
			table.appendChild(cell);
		}
		return table;
	}

	private commitLink(hash: Hash): HTMLElement {
		const link = el('a', 'mono commit-link', shortHash(hash));
		link.title = `Go to ${hash} (if it is loaded in the graph)`;
		link.tabIndex = 0;
		const go = () => this.callbacks.onRevealCommit(hash);
		link.addEventListener('click', go);
		link.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') go();
		});
		return link;
	}

	private renderFile(target: ChangeTarget, change: FileChange): HTMLElement {
		const row = el('div', 'file');
		row.tabIndex = 0;
		row.title = `${change.path}${change.oldPath !== null ? `\nRenamed from ${change.oldPath}` : ''}\n${STATUS_NAMES[change.type]} — click to open the diff`;

		row.appendChild(el('span', `status status-${change.type}`, change.type));
		const slash = change.path.lastIndexOf('/');
		const name = el('span', `file-name${change.type === FileChangeType.Deleted ? ' deleted' : ''}`, change.path.slice(slash + 1));
		row.appendChild(name);
		const dirText = slash === -1 ? '' : change.path.slice(0, slash);
		row.appendChild(el('span', 'file-dir', change.oldPath !== null ? `${dirText}  ← ${change.oldPath}` : dirText));
		if (change.additions !== null && change.deletions !== null) {
			const stats = el('span', 'file-stats');
			stats.append(el('span', 'additions', `+${change.additions}`), el('span', 'deletions', `−${change.deletions}`));
			row.appendChild(stats);
		} else if (change.type !== FileChangeType.Untracked) {
			row.appendChild(el('span', 'file-stats', 'binary'));
		}

		const open = () => this.callbacks.onOpenDiff(target, change);
		row.addEventListener('click', open);
		row.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') open();
		});
		row.addEventListener('contextmenu', (event) => {
			event.preventDefault();
			this.callbacks.onFileContextMenu(event, target, change);
		});
		return row;
	}

	private installResize(handle: HTMLElement): void {
		handle.addEventListener('mousedown', (start) => {
			start.preventDefault();
			const startY = start.clientY;
			const startHeight = this.element.getBoundingClientRect().height;
			const move = (event: MouseEvent) => {
				const max = window.innerHeight * MAX_FRACTION;
				this.setHeight(Math.min(max, startHeight + (startY - event.clientY)));
			};
			const up = () => {
				document.removeEventListener('mousemove', move);
				document.removeEventListener('mouseup', up);
				this.callbacks.onResize(this.element.getBoundingClientRect().height);
			};
			document.addEventListener('mousemove', move);
			document.addEventListener('mouseup', up);
		});
	}
}
