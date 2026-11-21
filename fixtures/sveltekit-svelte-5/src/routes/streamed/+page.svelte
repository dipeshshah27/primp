<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Streamed: SvelteKit fixture</title>
</svelte:head>

<section class="streamed" data-label="streamed">
	<h1 class="streamed-title" data-label="streamed-title">Streamed response</h1>
	<p class="shell" data-label="streamed-shell">
		This paragraph is in the first chunk. The value below arrives about {data.delayMs} ms later in
		the same HTTP response.
	</p>

	<!-- Not labelled: which branch is in the DOM depends on timing. -->
	{#await data.slow}
		<p class="value pending" id="streamed-value" data-state="pending">waiting for the server</p>
	{:then value}
		<p class="value" id="streamed-value" data-state="resolved">{value}</p>
	{:catch}
		<p class="value" id="streamed-value" data-state="failed">the streamed value failed</p>
	{/await}
</section>

<style>
	.streamed {
		display: grid;
		gap: 16px;
		padding-top: 48px;
	}

	.streamed-title {
		font-size: 36px;
		line-height: 1.15;
	}

	.shell {
		color: var(--ink-soft);
		max-width: 60ch;
	}

	.value {
		min-height: 48px;
		padding: 12px 16px;
		border: 1px dashed var(--line);
		border-radius: var(--radius);
		font-weight: 600;
	}

	.value.pending {
		color: var(--ink-soft);
		font-weight: 400;
	}

	@media (max-width: 640px) {
		.streamed {
			padding-top: 28px;
		}

		.streamed-title {
			font-size: 28px;
		}
	}
</style>
