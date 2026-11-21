<script lang="ts">
	type Tone = 'plain' | 'warm' | 'cool';

	let { title, body, tone = 'plain' }: { title: string; body: string; tone?: Tone } = $props();
</script>

<!-- Rendered once per feature, so these labels appear several times in the DOM. -->
<li class="card" data-tone={tone} data-label="feature-card">
	<h3 class="card-title" data-label="feature-card-title">{title}</h3>
	<p class="card-body" data-label="feature-card-body">{body}</p>
</li>

<style>
	.card {
		display: grid;
		gap: 8px;
		align-content: start;
		padding: 20px;
		border: 1px solid var(--line);
		border-top: 4px solid var(--ink-soft);
		border-radius: var(--radius);
		background: var(--card);
	}

	.card[data-tone='warm'] {
		border-top-color: var(--accent);
	}

	.card[data-tone='cool'] {
		border-top-color: #2f6f9f;
	}

	.card-title {
		font-size: 18px;
	}

	.card-body {
		color: var(--ink-soft);
		font-size: 15px;
	}

	@media (max-width: 640px) {
		.card {
			padding: 14px;
		}
	}
</style>
