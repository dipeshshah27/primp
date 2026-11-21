<svelte:head>
	<title>Server only: SvelteKit fixture</title>
</svelte:head>

<section class="server-only" data-label="server-only">
	<h1 class="server-only-title" data-label="server-only-title">Rendered on the server only</h1>
	<p class="server-only-note" data-label="server-only-note">
		This route sets <code>csr = false</code>, so the browser gets HTML and CSS and no component
		code.
	</p>
</section>

<style>
	.server-only {
		display: grid;
		gap: 16px;
		padding-top: 48px;
	}

	.server-only-title {
		font-size: 36px;
		line-height: 1.15;
	}

	.server-only-note {
		color: var(--ink-soft);
		max-width: 60ch;
	}

	@media (max-width: 640px) {
		.server-only {
			padding-top: 28px;
		}

		.server-only-title {
			font-size: 28px;
		}
	}
</style>
