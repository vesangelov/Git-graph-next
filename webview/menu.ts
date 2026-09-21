import { el } from './render/table.ts';

export type MenuItem = { readonly label: string; readonly action: () => void; readonly disabled?: boolean } | { readonly separator: true };

/**
 * A context menu drawn inside the webview.
 *
 * VS Code's native webview context menus have changed behaviour between
 * releases (#873) and are not available in every build (#863), so the graph
 * owns its menu entirely: it depends only on DOM events.
 */
export class ContextMenu {
	readonly element: HTMLElement;
	private items: HTMLElement[] = [];
	private active = -1;

	constructor() {
		this.element = el('div', 'context-menu');
		this.element.hidden = true;
		this.element.setAttribute('role', 'menu');

		// Close on any interaction outside the menu. Capture phase, so the click
		// that closes the menu is not also swallowed by whatever is beneath it.
		document.addEventListener('mousedown', (event) => {
			if (!this.element.hidden && !this.element.contains(event.target as Node)) this.close();
		}, true);
		window.addEventListener('blur', () => this.close());
		window.addEventListener('resize', () => this.close());
		document.addEventListener('keydown', (event) => this.onKey(event), true);
	}

	open(x: number, y: number, entries: readonly MenuItem[]): void {
		this.element.replaceChildren();
		this.items = [];
		this.active = -1;

		for (const entry of entries) {
			if ('separator' in entry) {
				this.element.appendChild(el('div', 'separator'));
				continue;
			}
			const item = el('div', 'item', entry.label);
			item.setAttribute('role', 'menuitem');
			if (entry.disabled === true) {
				item.classList.add('disabled');
			} else {
				item.addEventListener('click', () => {
					this.close();
					entry.action();
				});
				item.addEventListener('mouseenter', () => this.highlight(this.items.indexOf(item)));
				this.items.push(item);
			}
			this.element.appendChild(item);
		}
		// A trailing separator, left by an empty final group, looks broken.
		while (this.element.lastElementChild?.classList.contains('separator')) this.element.lastElementChild.remove();

		this.element.hidden = false;
		// Keep the menu on screen: flip it left/up when it would overflow.
		const rect = this.element.getBoundingClientRect();
		const left = x + rect.width > window.innerWidth ? Math.max(0, x - rect.width) : x;
		const top = y + rect.height > window.innerHeight ? Math.max(0, y - rect.height) : y;
		this.element.style.left = `${left}px`;
		this.element.style.top = `${top}px`;
	}

	close(): void {
		if (this.element.hidden) return;
		this.element.hidden = true;
		this.element.replaceChildren();
		this.items = [];
	}

	private highlight(index: number): void {
		this.active = index;
		this.items.forEach((item, i) => item.classList.toggle('active', i === index));
	}

	private onKey(event: KeyboardEvent): void {
		if (this.element.hidden) return;
		const count = this.items.length;
		switch (event.key) {
			case 'Escape':
				this.close();
				break;
			case 'ArrowDown':
				if (count > 0) this.highlight((this.active + 1) % count);
				break;
			case 'ArrowUp':
				if (count > 0) this.highlight((this.active - 1 + count) % count);
				break;
			case 'Enter':
				this.items[this.active]?.click();
				break;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	}
}
