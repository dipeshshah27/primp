import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Fixture convention: the dev server honours PORT and binds to localhost.
// When PORT is set the port is strict, so a test never silently gets a different one.
const port = process.env.PORT ? Number(process.env.PORT) : undefined;

// Optional. Vite keeps its pre-bundled dependencies in node_modules/.vite, keyed by the
// project root. Copies of this fixture that symlink node_modules back to the checked-in one
// therefore share that directory and re-write it on every start. A test that runs several
// copies at once can give each its own cache with PRIMP_FIXTURE_CACHE_DIR (absolute, or
// relative to the fixture root). Unset, Vite's default applies.
const cacheDir = process.env.PRIMP_FIXTURE_CACHE_DIR || undefined;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  cacheDir,
  server: {
    host: 'localhost',
    port: port ?? 5173,
    strictPort: port !== undefined,
    open: false,
  },
});
