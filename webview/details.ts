import { FileChangeType, STAGED, isUncommittedRow, type ChangeTarget, type Commit, type FileChange, type Hash } from '../src/types.ts';
import { formatDateLong, shortHash } from './format.ts';
import { appendMessage, el, type RefLabel } from './render/table.ts';
import type { IssueLinkRule } from '../src/git/remote.ts';
import type { ReviewSummary } from '../src/view/protocol.ts';

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
	/** Every changed file in one editor (#807). */
	onOpenAllChanges(target: ChangeTarget, title: string): void;
	onStartReview(target: ChangeTarget, title: string): void;
	onReview(command: 'next' | 'previous' | 'end'): void;
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
	private readonly actions: HTMLElement;
	/** The files shown, kept to redraw review marks without reloading. */
	private shownChanges: readonly FileChange[] | null = null;
	/** The active code review, when it is of what the pane shows. */
	private review: ReviewSummary | null = null;
	private allReviews: ReviewSummary | null = null;
	/** A single commit, a comparison of two (#182), or a summary of more. */
	private mode: 'single' | 'compare' | 'summary' = 'single';
	private links: readonly IssueLinkRule[] = [];

	constructor(private readonly callbacks: DetailsCallbacks) {
		this.element = el('div', 'details');
		this.element.hidden = true;

		const handle = el('div', 'resize-handle');
		handle.title = 'Drag to resize';
		this.installResize(handle);

		const header = el('div', 'details-header');
		this.title = el('span', 'details-title');
		this.actions = el('span', 'details-actions');
		const close = el('button', 'icon-button', '×');
		close.title = 'Close (Escape)';
		close.addEventListener('click', () => this.callbacks.onClose());
		header.append(this.title, this.actions, close);

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

	/** The commit shown on its own, or null (nothing, or a multi-selection). */
	get currentHash(): Hash | null {
		return this.isOpen && this.mode === 'single' ? (this.target?.hash ?? null) : null;
	}

	setHeight(height: number): void {
		this.element.style.height = `${Math.max(MIN_HEIGHT, height)}px`;
	}

	/** Shows a commit; its files arrive later through `showChanges`. */
	/**
	 * Compares two commits (#182): the files changed from `older` to `newer`.
	 * Either may be the Uncommitted Changes row, which stands for the working tree.
	 */
	openComparison(repo: string, older: Commit, newer: Commit): ChangeTarget {
		this.mode = 'compare';
		this.target = { repo, hash: newer.hash, base: older.hash };
		this.shownChanges = null;
		this.element.hidden = false;
		const name = (c: Commit) => (isUncommittedRow(c.hash) ? 'working tree' : shortHash(c.hash));
		this.title.textContent = `Comparing ${name(older)} → ${name(newer)}`;
		this.title.title = this.title.textContent;
		const row = (c: Commit) => {
			const cell = el('span');
			if (isUncommittedRow(c.hash)) cell.textContent = c.hash === STAGED ? 'Staged changes' : 'Uncommitted changes';
			else cell.append(this.commitLink(c.hash), `  ${c.subject}`);
			return cell;
		};
		this.meta.replaceChildren(
			this.table([
				['From', row(older)],
				['To', row(newer)]
			]),
			el('div', 'details-message', 'Every change between the two, as one diff per file. Right-click the selection for actions on both commits.')
		);
		this.files.replaceChildren(el('div', 'details-note', 'Loading changed files…'));
		this.syncReview();
		return this.target;
	}

	/**
	 * Compares something with the working tree (#782), without both sides
	 * being loaded commits.
	 */
	openWorkingTreeComparison(target: ChangeTarget, fromLabel: string): ChangeTarget {
		this.mode = 'compare';
		this.target = target;
		this.shownChanges = null;
		this.element.hidden = false;
		this.title.textContent = `Comparing ${fromLabel} → working tree`;
		this.title.title = this.title.textContent;
		this.meta.replaceChildren(
			this.table([['From', fromLabel], ['To', 'The files as they are now, including uncommitted changes']]),
			el('div', 'details-message', 'Every difference between that commit and your working tree.')
		);
		this.files.replaceChildren(el('div', 'details-note', 'Loading changed files…'));
		this.syncReview();
		return this.target;
	}

	/** Lists a multi-selection of more than two commits. */
	openSummary(commits: readonly Commit[]): void {
		this.mode = 'summary';
		this.target = null;
		this.element.hidden = false;
		this.title.textContent = `${commits.length} commits selected`;
		const list = el('div', 'details-message');
		for (const commit of commits) {
			const line = el('div');
			line.append(this.commitLink(commit.hash), `  ${commit.subject}`);
			list.appendChild(line);
		}
		this.meta.replaceChildren(list);
		this.renderActions();
		this.files.replaceChildren(el('div', 'details-note', 'Right-click the selection for actions on all of them: cherry-pick, revert, squash, drop, create patches.'));
	}

	open(repo: string, commit: Commit, labels: readonly RefLabel[], links: readonly IssueLinkRule[] = []): void {
		this.mode = 'single';
		this.links = links;
		this.shownChanges = null;
		this.target = changeTarget(repo, commit);
		this.element.hidden = false;
		this.title.textContent = isUncommittedRow(commit.hash) ? commit.subject : `${shortHash(commit.hash)}  ${commit.subject}`;
		this.title.title = this.title.textContent;
		this.renderMeta(commit, labels);
		this.files.replaceChildren(el('div', 'details-note', 'Loading changed files…'));
		this.syncReview();
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

	/** The active code review (or none); redraws the marks when it is of what is shown. */
	setReview(review: ReviewSummary | null): void {
		this.allReviews = review;
		this.syncReview();
		if (this.target !== null && this.shownChanges !== null) this.showChanges(this.target.hash, this.shownChanges, null);
	}

	private syncReview(): void {
		const target = this.target;
		const review = this.allReviews;
		this.review = review !== null && target !== null && review.repo === target.repo && review.hash === target.hash && review.base === target.base ? review : null;
		this.renderActions();
	}

	/** All Changes and Review, or the active review's progress and navigation. */
	private renderActions(): void {
		const target = this.target;
		const button = (text: string, title: string, action: () => void, primary = false) => {
			const element = el('button', `details-button${primary ? ' primary' : ''}`, text);
			element.title = title;
			element.addEventListener('click', action);
			return element;
		};
		if (target === null || this.mode === 'summary') {
			this.actions.replaceChildren();
			return;
		}
		const title = this.title.textContent ?? '';
		const items: HTMLElement[] = [button('All Changes', 'Open every changed file in one scrolling editor', () => this.callbacks.onOpenAllChanges(target, title))];
		const review = this.review;
		if (review === null) {
			items.push(button('Review', 'Start a code review: go through the files one by one, tracking which you have seen (Alt+] next, Alt+[ previous)', () => this.callbacks.onStartReview(target, title), true));
		} else {
			const done = review.reviewed.length === review.total;
			items.push(
				el('span', `review-progress${done ? ' done' : ''}`, `${review.reviewed.length}/${review.total} reviewed`),
				button('‹ Prev', 'Previous file not yet reviewed (Alt+[)', () => this.callbacks.onReview('previous')),
				button('Next ›', 'Next file not yet reviewed (Alt+])', () => this.callbacks.onReview('next'), !done),
				button('End Review', 'End this code review', () => this.callbacks.onReview('end'))
			);
		}
		this.actions.replaceChildren(...items);
	}

	/** Shows a commit's files, unless the pane has since moved to another commit. */
	showChanges(hash: Hash, changes: readonly FileChange[] | null, error: string | null): void {
		const target = this.target;
		if (target === null || target.hash !== hash) return;
		this.shownChanges = changes;
		this.renderActions();
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
		const reviewed = new Set(this.review?.reviewed ?? []);
		for (const change of changes) {
			const row = this.renderFile(target, change);
			if (this.review !== null) {
				row.classList.toggle('reviewed', reviewed.has(change.path));
				row.classList.toggle('current', this.review.current === change.path);
			}
			list.appendChild(row);
		}
		this.files.replaceChildren(summary, list);
	}

	private renderMeta(commit: Commit, labels: readonly RefLabel[]): void {
		const rows: [string, HTMLElement | string][] = [];

		if (isUncommittedRow(commit.hash)) {
			const parent = commit.parents[0];
			rows.push(['Against', parent === undefined ? 'nothing' : parent === STAGED ? 'the staged changes' : this.commitLink(parent)]);
			const what =
				commit.hash === STAGED
					? 'What is staged, compared with the last commit.'
					: parent === STAGED
						? 'What is changed but not staged yet, compared with the index.'
						: 'Changes in the index and working tree, compared with HEAD.';
			this.meta.replaceChildren(this.table(rows), el('div', 'details-message', what));
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
		// Read out as one sentence; Enter opens the diff, the menu key its actions.
		row.setAttribute('role', 'button');
		const counts = change.additions !== null && change.deletions !== null ? `, ${change.additions} added, ${change.deletions} removed` : '';
		row.setAttribute('aria-label', `${STATUS_NAMES[change.type]} ${change.path}${change.oldPath !== null ? `, renamed from ${change.oldPath}` : ''}${counts}`);

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
