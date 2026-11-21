<script lang="ts">
	let { title, lede }: { title: string; lede: string } = $props();
</script>

<section class="hero" data-label="hero">
	<h1 class="title" data-label="hero-title">{title}</h1>
	<p class="lede" data-label="hero-lede">{lede}</p>
	<a class="cta" href="#signin" data-label="hero-cta">Sign in to continue</a>
</section>

<style>
	.hero {
		display: grid;
		justify-items: start;
		gap: 16px;
		padding: 56px 0 40px;
	}

	.title {
		font-size: 44px;
		line-height: 1.1;
		letter-spacing: -0.02em;
		max-width: 18ch;
	}

	.lede {
		font-size: 19px;
		color: var(--ink-soft);
		max-width: 52ch;
	}

	.cta {
		display: inline-block;
		padding: 10px 18px;
		border-radius: var(--radius);
		background: var(--accent);
		color: var(--accent-ink);
		font-weight: 600;
		text-decoration: none;
	}

	.cta:hover {
		filter: brightness(1.08);
	}

	@media (max-width: 640px) {
		.hero {
			padding: 32px 0 24px;
		}

		.title {
			font-size: 30px;
		}

		.lede {
			font-size: 17px;
		}
	}
</style>
