import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import Svedit from '../lib/Svedit.svelte';
import create_test_session from './create_test_session.js';

async function render_canvas(editable: boolean) {
	const session = create_test_session();
	session.config = { ...session.config, is_blank_node: (node: any) => node.type === 'list' };
	const { container } = await render(Svedit, { session, path: ['page_1'], editable });
	await tick();
	return container.querySelector('.svedit-canvas') as HTMLElement;
}

describe('blank nodes', () => {
	it('renders blank nodes as nothing outside editing', async () => {
		const canvas = await render_canvas(false);
		expect(canvas.querySelector('[data-path="page_1__body__2"]')).toBeNull();
		const last_shown = canvas.querySelector('[data-path="page_1__body__1"]')!;
		expect(last_shown.classList.contains('last')).toBe(true);
	});

	it('renders blank nodes while editing', async () => {
		const canvas = await render_canvas(true);
		const list = canvas.querySelector('[data-path="page_1__body__2"]')!;
		expect(list).not.toBeNull();
		expect(list.classList.contains('last')).toBe(true);
	});
});

describe('placeholders', () => {
	it('shows text placeholders only while editing', async () => {
		const button = '[data-path="page_1__body__0__buttons__0__content"]';
		expect((await render_canvas(true)).querySelector(button)!.getAttribute('placeholder')).toBe(
			'Call to Action'
		);
		expect((await render_canvas(false)).querySelector(button)!.hasAttribute('placeholder')).toBe(
			false
		);
	});
});
