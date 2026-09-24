import { el } from './render/table.ts';

export type MenuItem = { readonly label: string; readonly action: () => void; readonly disabled?: boolean } | { readonly separator: true };

/**
 * A context menu drawn inside the webview.
 *
 * VS Code's native webview context menus have changed behaviour between
 * releases (#873) and are not available in every build (#863), so the graph
 * owns its menu entirely: it depends only on DOM events.
 *
 * While open, the menu holds focus and names its highlighted item as the
 * active descendant, so a screen reader follows the arrow keys; on closing,
 * focus goes back to where it was.
 */
export class ContextMenu {
	readonly element: HTMLElement;
	private items: HTMLElement[] = [];
	private active = -1;
	/** What had focus before the menu opened, to give it back. */
	private returnFocus: HTMLElement | null = null;

	constructor() {
		this.element = el('div', 'context-menu');
		this.element.hidden = true;
		this.element.tabIndex = -1;
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

	/**
	 * Opens the menu at a viewport position. `keyboard` highlights the first
	 * item at once, as a menu opened from the keyboard should, so Enter works
	 * without a first arrow press.
	 */
	open(x: number, y: number, entries: readonly MenuItem[], keyboard = false): void {
		const focused = document.activeElement;
		if (focused instanceof HTMLElement && !this.element.contains(focused)) this.returnFocus = focused;
		this.element.replaceChildren();
		this.element.removeAttribute('aria-activedescendant');
		this.items = [];
		this.active = -1;

		for (const entry of entries) {
			if ('separator' in entry) {
				const separator = el('div', 'separator');
				separator.setAttribute('role', 'separator');
				this.element.appendChild(separator);
				continue;
			}
			const item = el('div', 'item', entry.label);
			item.setAttribute('role', 'menuitem');
			if (entry.disabled === true) {
				item.classList.add('disabled');
				item.setAttribute('aria-disabled', 'true');
			} else {
				item.id = `menu-item-${this.items.length}`;
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
		this.element.focus({ preventScroll: true });
		if (keyboard && this.items.length > 0) this.highlight(0);
	}

	close(): void {
		if (this.element.hidden) return;
		this.element.hidden = true;
		this.element.replaceChildren();
		this.element.removeAttribute('aria-activedescendant');
		this.items = [];
		const back = this.returnFocus;
		this.returnFocus = null;
		if (back?.isConnected === true) back.focus({ preventScroll: true });
	}

	private highlight(index: number): void {
		this.active = index;
		this.items.forEach((item, i) => item.classList.toggle('active', i === index));
		const item = this.items[index];
		if (item !== undefined) this.element.setAttribute('aria-activedescendant', item.id);
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
			case 'Home':
				if (count > 0) this.highlight(0);
				break;
			case 'End':
				if (count > 0) this.highlight(count - 1);
				break;
			case 'Enter':
			case ' ':
				this.items[this.active]?.click();
				break;
			case 'Tab':
				// Focus leaves the menu: close it, as native menus do.
				this.close();
				return;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	}
}
