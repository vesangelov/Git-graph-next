import type { GraphData } from '../src/types.ts';
import { NO_FILTER, isFiltered, type FilterState } from '../src/view/protocol.ts';
import { el } from './render/table.ts';
import { joinArgs, splitArgs, validateArgs } from '../src/git/extraArgs.ts';

export interface BranchOption {
	/** Full ref name, as passed to git. */
	readonly ref: string;
	/** Short name shown to the user. */
	readonly name: string;
	readonly remote: boolean;
	/** Hidden by an exclude pattern (#360). */
	readonly excluded: boolean;
}

/** The branches offered by the picker: locals first, then remotes, each alphabetical. */
export function branchOptions(data: GraphData): BranchOption[] {
	const excluded = new Set(data.excludedRefs);
	const option = (ref: string, name: string, remote: boolean) => ({ ref, name, remote, excluded: excluded.has(ref) });
	const locals = data.heads.map((head) => option(`refs/heads/${head.name}`, head.name, false));
	const remotes = data.remoteHeads.map((remote) => option(`refs/remotes/${remote.name}`, remote.name, true));
	const byName = (a: BranchOption, b: BranchOption) => a.name.localeCompare(b.name);
	return [...locals.sort(byName), ...remotes.sort(byName)];
}

/**
 * Normalises a typed path to what git expects: repo-relative, forward
 * slashes, no leading `./` or `/`, no trailing slash.
 */
export function normalisePath(input: string): string {
	return input.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export interface FilterCallbacks {
	onChange(filter: FilterState): void;
}

/**
 * A text box that collects values as removable chips. Enter adds the typed
 * value, Backspace in an empty box removes the last chip. Used for authors and
 * paths, where values may contain spaces and commas, so no separator is safe.
 */
class ChipInput {
	readonly element: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly list: HTMLDataListElement;
	private values: string[] = [];

	constructor(
		label: string,
		placeholder: string,
		private readonly normalise: (value: string) => string,
		private readonly onChange: (values: string[]) => void
	) {
		this.element = el('label', 'chip-field');
		this.element.appendChild(el('span', 'chip-label', label));
		this.input = el('input');
		this.input.placeholder = placeholder;
		this.input.spellcheck = false;
		this.list = el('datalist');
		this.list.id = `chips-${label.toLowerCase()}`;
		this.input.setAttribute('list', this.list.id);
		this.element.append(this.input, this.list);

		this.input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.commit();
			} else if (event.key === 'Backspace' && this.input.value === '' && this.values.length > 0) {
				this.set(this.values.slice(0, -1), true);
			}
		});
		// Picking a datalist suggestion arrives as a replacement of the whole
		// text; plain typing does not, and waits for Enter.
		this.input.addEventListener('input', (event) => {
			if ((event as InputEvent).inputType === 'insertReplacementText' || (event as InputEvent).inputType === undefined) this.commit();
		});
	}

	set(values: readonly string[], notify = false): void {
		this.values = [...values];
		for (const chip of this.element.querySelectorAll('.chip')) chip.remove();
		for (const value of this.values) {
			const chip = el('span', 'chip');
			chip.appendChild(el('span', 'chip-text', value));
			const remove = el('button', 'chip-remove', '×');
			remove.title = `Remove "${value}"`;
			remove.type = 'button';
			remove.addEventListener('click', (event) => {
				event.preventDefault();
				this.set(this.values.filter((v) => v !== value), true);
			});
			chip.appendChild(remove);
			this.element.insertBefore(chip, this.input);
		}
		if (notify) this.onChange(this.values);
	}

	suggest(options: readonly string[]): void {
		this.list.replaceChildren(
			...options.filter((o) => !this.values.includes(o)).map((o) => {
				const option = el('option');
				option.value = o;
				return option;
			})
		);
	}

	private commit(): void {
		const value = this.normalise(this.input.value);
		this.input.value = '';
		if (value === '' || this.values.includes(value)) return;
		this.set([...this.values, value], true);
	}
}

/**
 * A text box for extra `git log` arguments (#591), applied on Enter or when
 * focus leaves. Invalid input is reported inline and not applied, so a typo
 * never replaces a working graph with an error.
 */
class ArgsInput {
	readonly element: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly error: HTMLElement;
	private applied: readonly string[] = [];

	constructor(private readonly onChange: (args: string[]) => void) {
		this.element = el('label', 'chip-field args-field');
		this.element.appendChild(el('span', 'chip-label', 'git log'));
		this.input = el('input');
		this.input.placeholder = 'Extra arguments, e.g. --no-merges --since="1 month ago"';
		this.input.spellcheck = false;
		this.error = el('span', 'args-error');
		this.element.append(this.input, this.error);

		this.input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.apply();
			} else if (event.key === 'Escape') {
				this.set(this.applied);
			}
		});
		this.input.addEventListener('blur', () => this.apply());
		this.input.addEventListener('input', () => this.check());
	}

	set(args: readonly string[]): void {
		this.applied = args;
		this.input.value = joinArgs(args);
		this.check();
	}

	/** Parses and validates the text; returns the arguments, or null after showing why not. */
	private check(): string[] | null {
		let args: string[];
		try {
			args = splitArgs(this.input.value);
		} catch (error) {
			return this.fail(error instanceof Error ? error.message : String(error));
		}
		const invalid = validateArgs(args);
		if (invalid !== null) return this.fail(invalid);
		this.error.textContent = '';
		this.element.classList.remove('invalid');
		return args;
	}

	private fail(message: string): null {
		this.error.textContent = message;
		this.element.classList.add('invalid');
		return null;
	}

	private apply(): void {
		const args = this.check();
		if (args === null || joinArgs(args) === joinArgs(this.applied)) return;
		this.applied = args;
		this.onChange(args);
	}
}

/**
 * The filter controls: a branch picker button for the toolbar (#760), and a
 * filter bar with author (#171) and path (#70) chips.
 */
export class FilterControls {
	readonly branchButton: HTMLButtonElement;
	readonly toggleButton: HTMLButtonElement;
	readonly bar: HTMLElement;
	private readonly popup: HTMLElement;
	private readonly authors: ChipInput;
	private readonly paths: ChipInput;
	private readonly excludes: ChipInput;
	private readonly logArgs: ArgsInput;
	private filter: FilterState = NO_FILTER;
	private branches: readonly BranchOption[] = [];
	private barOpen = false;

	constructor(private readonly callbacks: FilterCallbacks) {
		this.branchButton = el('button', 'dropdown-button');
		this.branchButton.title = 'Branches shown in the graph';
		this.branchButton.addEventListener('click', () => (this.popup.hidden ? this.openPopup() : this.closePopup()));

		this.toggleButton = el('button', 'icon-button filter-toggle', 'Filter');
		this.toggleButton.title = 'Filter by author or path';
		this.toggleButton.addEventListener('click', () => {
			this.barOpen = !this.barOpen;
			this.render();
		});

		this.popup = el('div', 'branch-popup');
		this.popup.hidden = true;
		document.addEventListener('mousedown', (event) => {
			const target = event.target as Node;
			if (!this.popup.hidden && !this.popup.contains(target) && !this.branchButton.contains(target)) this.closePopup();
		}, true);
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && !this.popup.hidden) {
				event.stopPropagation();
				this.closePopup();
			}
		}, true);

		this.bar = el('div', 'filter-bar');
		this.authors = new ChipInput('Author', 'Name or e-mail, Enter to add', (v) => v.trim(), (authors) => this.update({ authors }));
		this.paths = new ChipInput('Path', 'File or folder, Enter to add', normalisePath, (paths) => this.update({ paths }));
		this.logArgs = new ArgsInput((logArgs) => this.update({ logArgs }));
		this.excludes = new ChipInput('Hide', 'Pattern, e.g. dependabot/* — Enter to add', (v) => v.trim(), (excludes) => this.update({ excludes }));
		this.excludes.element.title =
			'Branches and tags matching these patterns are hidden (git log --exclude).\n' +
			'A pattern matches the name without refs/…/: feature/* (local), origin/feature/* (remote), nightly-* (tags). * also matches /.';
		const clear = el('button', 'link-button', 'Clear filters');
		clear.addEventListener('click', () => this.update(NO_FILTER));
		this.bar.append(this.authors.element, this.paths.element, this.logArgs.element, clear);
		this.render();
	}

	get popupElement(): HTMLElement {
		return this.popup;
	}

	get current(): FilterState {
		return this.filter;
	}

	/** Shows a filter without reporting it as a change. */
	set(filter: FilterState): void {
		this.filter = filter;
		// A filter applied from outside (View File History) must be visible.
		if (filter.authors.length > 0 || filter.paths.length > 0 || filter.logArgs.length > 0) this.barOpen = true;
		this.syncInputs();
		this.render();
	}

	private syncInputs(): void {
		this.authors.set(this.filter.authors);
		this.paths.set(this.filter.paths);
		this.excludes.set(this.filter.excludes);
		this.logArgs.set(this.filter.logArgs);
	}

	/** Refreshes the picker's branch list and the author suggestions from newly loaded data. */
	setData(data: GraphData, knownAuthors: readonly string[]): void {
		this.branches = branchOptions(data);
		this.authors.suggest(knownAuthors);
		this.render();
		if (!this.popup.hidden) this.renderPopup();
	}

	update(change: Partial<FilterState>): void {
		this.filter = { ...this.filter, ...change };
		this.syncInputs();
		this.render();
		if (!this.popup.hidden) this.renderPopup();
		this.callbacks.onChange(this.filter);
	}

	private render(): void {
		const selected = this.filter.branches;
		const short = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '');
		const hidden = this.filter.excludes.length;
		this.branchButton.textContent =
			(selected.length === 0 ? 'All Branches' : selected.length === 1 ? short(selected[0]) : `${selected.length} Branches`) +
			(hidden > 0 ? ` (${hidden} hidden)` : '');
		this.branchButton.classList.toggle('active', selected.length > 0 || hidden > 0);

		const count = this.filter.authors.length + this.filter.paths.length + (this.filter.logArgs.length > 0 ? 1 : 0);
		this.toggleButton.textContent = count > 0 ? `Filter (${count})` : 'Filter';
		this.toggleButton.classList.toggle('active', count > 0);
		this.bar.hidden = !this.barOpen && count === 0;
		this.bar.classList.toggle('filtered', isFiltered(this.filter));
	}

	private openPopup(): void {
		this.popup.hidden = false;
		this.renderPopup();
		const rect = this.branchButton.getBoundingClientRect();
		this.popup.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - this.popup.offsetWidth - 4))}px`;
		this.popup.style.top = `${rect.bottom + 2}px`;
		this.popup.querySelector('input')?.focus();
	}

	private closePopup(): void {
		this.popup.hidden = true;
	}

	private renderPopup(): void {
		const previous = this.popup.querySelector<HTMLInputElement>('input.branch-search');
		const query = previous?.value ?? '';
		const hadFocus = previous !== null && document.activeElement === previous;
		const search = el('input', 'branch-search');
		search.placeholder = 'Search branches';
		search.value = query;
		search.spellcheck = false;

		const list = el('div', 'branch-list');
		const fill = () => {
			const needle = search.value.trim().toLowerCase();
			const rows: HTMLElement[] = [this.branchRow('All Branches', this.filter.branches.length === 0, () => this.update({ branches: [] }))];
			let lastRemote: boolean | null = null;
			for (const option of this.branches) {
				if (needle !== '' && !option.name.toLowerCase().includes(needle)) continue;
				if (option.remote !== lastRemote) {
					rows.push(el('div', 'branch-group', option.remote ? 'Remote' : 'Local'));
					lastRemote = option.remote;
				}
				const checked = this.filter.branches.includes(option.ref);
				const row = this.branchRow(option.name, checked, () => {
					const next = checked ? this.filter.branches.filter((r) => r !== option.ref) : [...this.filter.branches, option.ref];
					this.update({ branches: next });
				});
				if (option.excluded) {
					row.classList.add('excluded');
					row.title = `${option.name} — hidden by an exclude pattern`;
				}
				rows.push(row);
			}
			list.replaceChildren(...rows);
		};
		search.addEventListener('input', fill);
		search.addEventListener('keydown', (event) => {
			// Enter picks the only match, the common case when searching.
			if (event.key !== 'Enter') return;
			const matches = this.branches.filter((o) => o.name.toLowerCase().includes(search.value.trim().toLowerCase()));
			if (matches.length === 1) this.update({ branches: [matches[0].ref] });
		});
		fill();
		const hideSection = el('div', 'branch-hide');
		hideSection.appendChild(this.excludes.element);
		this.popup.replaceChildren(search, list, hideSection);
		if (hadFocus) search.focus();
	}

	private branchRow(text: string, checked: boolean, toggle: () => void): HTMLElement {
		const row = el('label', 'branch-option');
		const box = el('input');
		box.type = 'checkbox';
		box.checked = checked;
		box.addEventListener('change', toggle);
		row.append(box, el('span', '', text));
		row.title = text;
		return row;
	}
}
