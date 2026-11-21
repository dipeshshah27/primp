<script lang="ts">
	import AccountCard from '#lib/components/AccountCard.svelte';
	import FeatureCard from '#lib/components/FeatureCard.svelte';
	import Hero from '#lib/components/Hero.svelte';
	import Panel from '#lib/components/Panel.svelte';
	import SignInForm from '#lib/components/SignInForm.svelte';
	import features from '#lib/data/features.json';
	import type { PageProps } from './$types';

	type Tone = 'plain' | 'warm' | 'cool';

	let { data, form }: PageProps = $props();

	let measured = $state(0);
</script>

<svelte:head>
	<title>Plumb &amp; Level: SvelteKit fixture</title>
</svelte:head>

<Hero
	title="Joinery that stays where you put it"
	lede="A small SvelteKit page with scoped styles, a form action and a session cookie."
/>

<section class="features" data-label="features">
	<h2 class="features-title" data-label="features-title">What you get</h2>
	<ul class="feature-list" data-label="feature-list">
		{#each features as feature (feature.title)}
			<FeatureCard title={feature.title} body={feature.body} tone={feature.tone as Tone} />
		{/each}
	</ul>
</section>

<Panel title="Workshop note">
	<!-- Written here, rendered inside Panel.svelte: the source of these two is this file. -->
	<p class="panel-body" data-label="panel-body">
		Measurements taken so far: <strong data-label="measure-count">{measured}</strong>
	</p>
	<button class="measure" type="button" onclick={() => (measured += 1)} data-label="measure-button">
		Take a measurement
	</button>
</Panel>

{#if data.user}
	<AccountCard user={data.user} />
{:else}
	<SignInForm name={form?.name ?? ''} error={form?.error ?? null} />
{/if}

<style>
	.features {
		display: grid;
		gap: 16px;
	}

	.features-title {
		font-size: 26px;
	}

	.feature-list {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--gap);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.panel-body {
		color: var(--ink-soft);
	}

	.measure {
		justify-self: start;
		padding: 8px 14px;
		border: 1px solid var(--ink);
		border-radius: 6px;
		background: var(--card);
		font: inherit;
		cursor: pointer;
	}

	.measure:hover {
		background: var(--ink);
		color: #ffffff;
	}

	@media (max-width: 640px) {
		.feature-list {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
