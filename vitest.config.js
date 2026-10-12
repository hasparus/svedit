import { defineConfig, mergeConfig } from 'vitest/config';
import { preview } from '@vitest/browser-preview';
import { playwright } from '@vitest/browser-playwright';
import vite_config from './vite.config.js';

export default mergeConfig(
	vite_config,
	defineConfig({
		test: {
			browser: {
				// Headless Playwright on CI (and in apps that run these tests on
				// their CI); a visible browser window locally.
				provider: process.env.CI ? playwright() : preview(),
				enabled: true,
				headless: !!process.env.CI,
				// at least one instance is required
				instances: [{ browser: 'chromium' }]
			},
			clearMocks: true,
			include: ['src/**/*.svelte.{test,spec}.{js,ts}']
		}
	})
);
