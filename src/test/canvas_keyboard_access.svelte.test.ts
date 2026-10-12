import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import Svedit from '../lib/Svedit.svelte';
import create_test_session from './create_test_session.js';

async function render_canvas(props: Record<string, unknown>) {
	const session = create_test_session();
	const { container } = await render(Svedit, { session, path: ['page_1'], ...props });
	await tick();
	return container.querySelector('.svedit-canvas') as HTMLElement;
}

describe('canvas keyboard access', () => {
	it('keeps the canvas out of the tab order by default', async () => {
		const canvas = await render_canvas({ editable: true });
		expect(canvas.getAttribute('tabindex')).toBe('-1');
		expect(canvas.hasAttribute('role')).toBe(false);
	});

	it('exposes an opted-in editable canvas as a labelled multiline textbox', async () => {
		const canvas = await render_canvas({
			editable: true,
			canvas_tabindex: 0,
			canvas_label: 'Contact details'
		});
		expect(canvas.getAttribute('tabindex')).toBe('0');
		expect(canvas.getAttribute('role')).toBe('textbox');
		expect(canvas.getAttribute('aria-multiline')).toBe('true');
		expect(canvas.getAttribute('aria-label')).toBe('Contact details');
	});

	it('never makes a read-only canvas a tab stop', async () => {
		const canvas = await render_canvas({ editable: false, canvas_tabindex: 0 });
		expect(canvas.getAttribute('tabindex')).toBe('-1');
		expect(canvas.hasAttribute('role')).toBe(false);
	});
});

describe('read-only editing', () => {
	it('renders in edit mode but takes no input', async () => {
		const canvas = await render_canvas({ editable: true, read_only: true, canvas_tabindex: 0 });
		expect(canvas.getAttribute('contenteditable')).toBe('false');
		expect(canvas.getAttribute('tabindex')).toBe('-1');
		expect(canvas.closest('.svedit')!.classList.contains('editable')).toBe(true);
		const event = new InputEvent('beforeinput', {
			inputType: 'insertText',
			data: 'x',
			cancelable: true,
			bubbles: true
		});
		canvas.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(true);
	});
});

describe('canvas focus', () => {
	async function render_with_session() {
		const session = create_test_session();
		const { container } = await render(Svedit, { session, path: ['page_1'], editable: true });
		await tick();
		const canvas = container.querySelector('.svedit-canvas') as HTMLElement;
		session.selection = { type: 'property', path: ['page_1', 'body', 0, 'image'] };
		return { session, canvas };
	}

	it('keeps the model selection on programmatic or keyboard focus', async () => {
		const { session, canvas } = await render_with_session();
		canvas.focus();
		expect(session.selection).toMatchObject({ type: 'property' });
	});

	it('yields to the selection a click is about to make', async () => {
		const { session, canvas } = await render_with_session();
		canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		canvas.focus();
		expect(session.selection).toBeNull();
	});
});
