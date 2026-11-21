<script lang="ts">
	import '../app.css';
	import SiteFooter from '#lib/components/SiteFooter.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<svelte:head>
	<meta name="description" content="reglet fixture: SvelteKit 3 with Svelte 5 runes" />
</svelte:head>

<SiteHeader user={data.user} />

<main class="page" data-label="page-main">
	{@render children()}
</main>

<SiteFooter />

<style>
	.page {
		display: grid;
		gap: 40px;
		width: min(100% - 2 * var(--gap), var(--measure));
		margin: 0 auto;
		padding-bottom: 56px;
	}

	@media (max-width: 640px) {
		.page {
			gap: 28px;
			padding-bottom: 32px;
		}
	}
</style>
