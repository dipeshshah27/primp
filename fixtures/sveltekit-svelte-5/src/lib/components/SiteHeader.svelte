<script lang="ts">
	import { page } from '$app/state';

	let { user }: { user: string | null } = $props();

	const current = $derived(page.url.pathname);
</script>

<header class="site-header" data-label="site-header">
	<a class="brand" href="/" data-label="brand-link">Plumb &amp; Level</a>

	<nav class="nav" aria-label="Main" data-label="main-nav">
		<a href="/" aria-current={current === '/' ? 'page' : undefined} data-label="nav-home">Home</a>
		<a
			href="/about"
			aria-current={current === '/about' ? 'page' : undefined}
			data-label="nav-about"
		>
			About
		</a>
		<a
			href="/streamed"
			aria-current={current === '/streamed' ? 'page' : undefined}
			data-label="nav-streamed"
		>
			Streamed
		</a>
		<a href="/server-only" data-sveltekit-reload data-label="nav-server-only">Server only</a>
	</nav>

	<span class="status" class:signed-in={user !== null} data-label="session-status">
		{user ? `Signed in as ${user}` : 'Signed out'}
	</span>
</header>

<style>
	.site-header {
		display: flex;
		align-items: center;
		gap: var(--gap);
		padding: 14px var(--gap);
		border-bottom: 1px solid var(--line);
		background: var(--card);
	}

	.brand {
		font-weight: 700;
		font-size: 18px;
		color: var(--ink);
		text-decoration: none;
	}

	.nav {
		display: flex;
		gap: 16px;
		margin-right: auto;
	}

	.nav a {
		color: var(--ink-soft);
		text-decoration: none;
		padding: 4px 0;
		border-bottom: 2px solid transparent;
	}

	.nav a:hover {
		color: var(--ink);
	}

	.nav a[aria-current='page'] {
		color: var(--ink);
		border-bottom-color: var(--accent);
	}

	.status {
		font-size: 14px;
		color: var(--ink-soft);
	}

	.status.signed-in {
		color: var(--ok);
		font-weight: 600;
	}

	@media (max-width: 640px) {
		.site-header {
			flex-wrap: wrap;
			gap: 8px 16px;
		}

		.status {
			flex-basis: 100%;
		}
	}
</style>
