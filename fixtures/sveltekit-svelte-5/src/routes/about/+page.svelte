<script lang="ts">
	import principles from '#lib/data/principles.json';
</script>

<svelte:head>
	<title>About: SvelteKit fixture</title>
</svelte:head>

<article class="about" data-label="about">
	<h1 class="about-title" data-label="about-title">How we work</h1>
	<p class="about-lede" data-label="about-lede">
		Three rules hang over the bench. They are short on purpose.
	</p>

	<ol class="rules" data-label="about-rules">
		{#each principles as principle (principle)}
			<li class="rule" data-label="about-rule">{principle}</li>
		{/each}
	</ol>

	<a class="back" href="/" data-label="about-back">Back to the front page</a>
</article>

<style>
	.about {
		display: grid;
		justify-items: start;
		gap: 16px;
		padding-top: 48px;
	}

	.about-title {
		font-size: 36px;
		line-height: 1.15;
	}

	.about-lede {
		font-size: 18px;
		color: var(--ink-soft);
	}

	.rules {
		display: grid;
		gap: 8px;
		margin: 0;
		padding-left: 24px;
	}

	.rule::marker {
		color: var(--accent);
		font-weight: 700;
	}

	.back:hover {
		text-decoration-thickness: 2px;
	}

	@media (max-width: 640px) {
		.about {
			padding-top: 28px;
		}

		.about-title {
			font-size: 28px;
		}
	}
</style>
