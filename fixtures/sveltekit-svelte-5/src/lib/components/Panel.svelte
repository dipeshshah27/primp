<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, children }: { title: string; children: Snippet } = $props();
</script>

<aside class="panel" data-label="panel">
	<h2 class="panel-title" data-label="panel-title">{title}</h2>
	<!-- Content authored by the parent component renders here. -->
	{@render children()}
</aside>

<style>
	.panel {
		display: grid;
		gap: 10px;
		padding: 20px 24px;
		border-left: 4px solid var(--accent);
		border-radius: 0 var(--radius) var(--radius) 0;
		background: #f3efe6;
	}

	.panel-title {
		font-size: 18px;
	}
</style>
