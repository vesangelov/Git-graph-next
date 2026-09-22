import { el } from './render/table.ts';

export type DialogField =
	| {
			readonly type: 'text';
			readonly id: string;
			readonly label: string;
			readonly value?: string;
			readonly placeholder?: string;
			/** Submit is refused while this field is empty. */
			readonly required?: boolean;
			readonly multiline?: boolean;
	  }
	| { readonly type: 'checkbox'; readonly id: string; readonly label: string; readonly value?: boolean; readonly hint?: string }
	| {
			readonly type: 'select';
			readonly id: string;
			readonly label: string;
			readonly options: readonly { readonly value: string; readonly label: string }[];
			readonly value?: string;
	  };

export interface DialogSpec {
	readonly title: string;
	/** Explanation above the fields; plain text, newlines kept. */
	readonly message?: string;
	readonly fields?: readonly DialogField[];
	readonly confirm: string;
	/** Destructive: the confirm button is drawn as a warning. */
	readonly danger?: boolean;
}

export type DialogValues = Readonly<Record<string, string | boolean>>;

/**
 * A modal dialog inside the webview, for confirming actions and collecting
 * their options.
 *
 * `submit` runs the action and resolves to an error message or null. On an
 * error the dialog stays open with the message, so a mistyped branch name can
 * be corrected instead of re-entered from scratch; on success it closes.
 */
export class Dialog {
	readonly element: HTMLElement;
	private readonly box: HTMLElement;
	private busy = false;

	constructor() {
		this.element = el('div', 'dialog-backdrop');
		this.element.hidden = true;
		this.box = el('div', 'dialog');
		this.box.setAttribute('role', 'dialog');
		this.box.setAttribute('aria-modal', 'true');
		this.element.appendChild(this.box);
		this.element.addEventListener('mousedown', (event) => {
			if (event.target === this.element && !this.busy) this.close();
		});
		document.addEventListener(
			'keydown',
			(event) => {
				if (this.element.hidden) return;
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					if (!this.busy) this.close();
				}
			},
			true
		);
	}

	get isOpen(): boolean {
		return !this.element.hidden;
	}

	open(spec: DialogSpec, submit: (values: DialogValues) => Promise<string | null>): void {
		this.busy = false;
		const form = el('form', 'dialog-form');
		form.noValidate = true;
		form.appendChild(el('div', 'dialog-title', spec.title));
		if (spec.message !== undefined) form.appendChild(el('div', 'dialog-message', spec.message));

		const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
		const required: string[] = [];
		for (const field of spec.fields ?? []) {
			const row = el('label', `dialog-field ${field.type}`);
			if (field.type === 'checkbox') {
				const box = el('input');
				box.type = 'checkbox';
				box.checked = field.value === true;
				row.append(box, el('span', '', field.label));
				if (field.hint !== undefined) row.appendChild(el('span', 'dialog-hint', field.hint));
				inputs.set(field.id, box);
			} else if (field.type === 'select') {
				const select = el('select');
				for (const option of field.options) {
					const element = el('option', '', option.label);
					element.value = option.value;
					select.appendChild(element);
				}
				if (field.value !== undefined) select.value = field.value;
				row.append(el('span', 'dialog-label', field.label), select);
				inputs.set(field.id, select);
			} else {
				const input = field.multiline === true ? el('textarea') : el('input');
				input.value = field.value ?? '';
				input.placeholder = field.placeholder ?? '';
				input.spellcheck = false;
				if (input instanceof HTMLTextAreaElement) input.rows = 4;
				row.append(el('span', 'dialog-label', field.label), input);
				inputs.set(field.id, input);
				if (field.required === true) required.push(field.id);
			}
			form.appendChild(row);
		}

		const error = el('div', 'dialog-error');
		error.hidden = true;
		const buttons = el('div', 'dialog-buttons');
		const cancel = el('button', 'dialog-button secondary', 'Cancel');
		cancel.type = 'button';
		cancel.addEventListener('click', () => this.close());
		const confirm = el('button', `dialog-button primary${spec.danger === true ? ' danger' : ''}`, spec.confirm);
		confirm.type = 'submit';
		buttons.append(cancel, confirm);
		form.append(error, buttons);

		const values = (): DialogValues => {
			const result: Record<string, string | boolean> = {};
			for (const [id, input] of inputs) result[id] = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value;
			return result;
		};
		const setBusy = (busy: boolean) => {
			this.busy = busy;
			confirm.disabled = busy;
			cancel.disabled = busy;
			for (const input of inputs.values()) input.disabled = busy;
			confirm.textContent = busy ? 'Working…' : spec.confirm;
		};

		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			if (this.busy) return;
			const current = values();
			const missing = required.find((id) => String(current[id]).trim() === '');
			if (missing !== undefined) {
				inputs.get(missing)?.focus();
				return;
			}
			error.hidden = true;
			setBusy(true);
			const message = await submit(current);
			if (this.element.hidden) return;
			setBusy(false);
			if (message === null) {
				this.close();
				return;
			}
			error.textContent = message;
			error.hidden = false;
		});
		// Enter submits from single-line inputs; in a textarea it is a newline.
		form.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLButtonElement)) {
				event.preventDefault();
				form.requestSubmit();
			}
		});

		this.box.replaceChildren(form);
		this.box.classList.toggle('danger', spec.danger === true);
		this.element.hidden = false;
		const first = [...inputs.values()].find((input) => !(input instanceof HTMLInputElement && input.type === 'checkbox'));
		(first ?? confirm).focus();
		if (first instanceof HTMLInputElement) first.select();
	}

	/** A message with a single OK button, e.g. for an action that failed without a dialog. */
	alert(title: string, message: string): void {
		this.open({ title, message, confirm: 'OK' }, async () => null);
		this.box.querySelector('.dialog-button.secondary')?.remove();
		this.box.querySelector('.dialog-message')?.classList.add('error');
	}

	close(): void {
		this.element.hidden = true;
		this.box.replaceChildren();
		this.busy = false;
	}
}
