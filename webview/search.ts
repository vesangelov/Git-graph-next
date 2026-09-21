import { el } from './render/table.ts';

const HELP = [
	'Search the loaded commits. All terms must match; case is ignored.',
	'',
	'fix typo            words anywhere (message, author, hash, refs)',
	'"fix typo"          an exact phrase',
	'author:alice        author name or e-mail',
	'committer:bob       committer name or e-mail',
	'message:"null"      subject or body',
	'hash:3f2a           hash prefix',
	'branch:feat  tag:v1  ref:release',
	'after:2024-01-01  before:2024-02  date:>=2024-03-15',
	'',
	'Enter / F3: next    Shift+Enter / Shift+F3: previous    Esc: close'
].join('\n');

export interface SearchBarCallbacks {
	onQuery(text: string): void;
	onNext(): void;
	onPrevious(): void;
	onSearchHistory(): void;
	onClose(): void;
}

export interface SearchStatus {
	/** Zero-based index of the current match, or -1. */
	readonly current: number;
	readonly total: number;
	/** More commits exist beyond those loaded. */
	readonly moreAvailable: boolean;
	readonly history: 'idle' | 'searching' | 'exhausted' | 'error';
	readonly error: string | null;
}

/** The search bar (#147): a query box, the match count, and navigation. */
export class SearchBar {
	readonly element: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly count: HTMLElement;
	private readonly historyButton: HTMLButtonElement;
	private inputTimer = 0;

	constructor(private readonly callbacks: SearchBarCallbacks) {
		this.element = el('div', 'search-bar');
		this.element.hidden = true;

		this.input = el('input', 'search-input');
		this.input.placeholder = 'Search commits — e.g. fix author:alice tag:v1 after:2024-01-01';
		this.input.spellcheck = false;
		this.input.addEventListener('input', () => {
			clearTimeout(this.inputTimer);
			this.inputTimer = window.setTimeout(() => {
				this.inputTimer = 0;
				this.callbacks.onQuery(this.input.value);
			}, 120);
		});
		this.input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				// Apply a still-pending edit before moving, so Enter never skips it.
				this.flush();
				if (event.shiftKey) this.callbacks.onPrevious();
				else this.callbacks.onNext();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				this.callbacks.onClose();
			}
		});

		this.count = el('span', 'search-count');
		const previous = this.button('↑', 'Previous match (Shift+Enter)', () => this.callbacks.onPrevious());
		const next = this.button('↓', 'Next match (Enter)', () => this.callbacks.onNext());
		this.historyButton = el('button', 'link-button search-history', 'Search older commits');
		this.historyButton.title = 'Look for the next match in commits that are not loaded yet, and load up to it';
		this.historyButton.addEventListener('click', () => this.callbacks.onSearchHistory());
		const help = el('span', 'search-help', '?');
		help.title = HELP;
		const close = this.button('×', 'Close (Escape)', () => this.callbacks.onClose());

		this.element.append(this.input, this.count, previous, next, this.historyButton, help, close);
	}

	get isOpen(): boolean {
		return !this.element.hidden;
	}

	get text(): string {
		return this.input.value;
	}

	open(): void {
		this.element.hidden = false;
		this.input.focus();
		this.input.select();
	}

	close(): void {
		this.element.hidden = true;
	}

	/** Runs a query whose debounce has not fired yet. */
	flush(): void {
		if (this.inputTimer === 0) return;
		clearTimeout(this.inputTimer);
		this.inputTimer = 0;
		this.callbacks.onQuery(this.input.value);
	}

	setStatus(status: SearchStatus, hasQuery: boolean): void {
		let text = '';
		if (status.history === 'searching') text = 'Searching history…';
		else if (status.error !== null) text = status.error;
		else if (!hasQuery) text = '';
		else if (status.total === 0) text = status.history === 'exhausted' ? 'No results' : status.moreAvailable ? 'None loaded' : 'No results';
		else text = `${status.current + 1} of ${status.total}${status.moreAvailable && status.history !== 'exhausted' ? '+' : ''}`;
		this.count.textContent = text;
		this.count.classList.toggle('error', status.error !== null || (hasQuery && status.total === 0 && status.history !== 'searching'));

		// Offer to look further only where the loaded matches run out.
		const atEnd = status.total === 0 || status.current === status.total - 1;
		this.historyButton.hidden = !hasQuery || !status.moreAvailable || !atEnd || status.history === 'exhausted';
		this.historyButton.disabled = status.history === 'searching';
	}

	private button(text: string, title: string, action: () => void): HTMLButtonElement {
		const button = el('button', 'icon-button', text);
		button.title = title;
		button.addEventListener('click', action);
		return button;
	}
}
