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
