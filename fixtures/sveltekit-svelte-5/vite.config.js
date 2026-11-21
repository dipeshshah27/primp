import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Fixture convention: the dev server honours PORT and binds to localhost.
// strictPort makes a busy port an error instead of a silent move to the next one.
const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || 'localhost';

/** @param {string} path a path relative to this file */
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Runes mode for everything in this project.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			}
		})
	],
	// Tests run copies of this fixture whose node_modules is a symlink back to the checked-in
	// install. Vite's default cache directory is inside node_modules, which those copies would
	// share, so the cache lives next to the config instead.
	cacheDir: here('./.vite'),
	server: {
		host,
		port,
		strictPort: true,
		fs: {
			// The real location of a symlinked node_modules has to be servable too.
			allow: [realpathSync(here('./node_modules'))]
		}
	},
	clearScreen: false
});
