import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import SveditTest from './testing_components/SveditTest.svelte';
import create_test_session from './create_test_session.js';

describe('dangling node references', () => {
	it('renders the rest of a node array when one referenced node is missing', async () => {
		const session = create_test_session();
		const { container } = await render(SveditTest, { session });
		await tick();
		// Remote merges assign the doc directly, without transaction validation.
		const nodes = { ...session.doc.nodes };
		delete nodes.list_1;
		session.doc = { ...session.doc, nodes };
		await tick();
		const canvas = container.querySelector('.svedit-canvas') as HTMLElement;
		expect(canvas.querySelector('[data-path="page_1__body__0"]')).not.toBeNull();
		expect(canvas.querySelector('[data-path="page_1__body__2"][data-type="node"]')).toBeNull();
	});
});
