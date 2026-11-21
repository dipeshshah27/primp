<script lang="ts">
	import { enhance } from '$app/forms';
	import { MAX_NAME_LENGTH } from '#lib/session.ts';

	let { name = '', error = null }: { name?: string; error?: string | null } = $props();
</script>

<!-- Rendered only while signed out; AccountCard takes its place after signing in. -->
<section class="signin" id="signin" data-label="signin">
	<h2 class="heading" data-label="signin-title">Sign in</h2>

	<form class="form" method="POST" action="?/signin" use:enhance data-label="signin-form">
		<label class="field-label" for="signin-name" data-label="signin-name-label">Your name</label>
		<input
			class="field"
			id="signin-name"
			name="name"
			type="text"
			autocomplete="off"
			maxlength={MAX_NAME_LENGTH}
			value={name}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? 'signin-error' : undefined}
			data-label="signin-name"
		/>
		<button class="submit" type="submit" data-label="signin-submit">Sign in</button>
	</form>

	{#if error}
		<p class="error" id="signin-error" role="alert">{error}</p>
	{/if}
</section>

<style>
	.signin {
		display: grid;
		gap: 12px;
		padding: 24px;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--card);
	}

	.heading {
		font-size: 22px;
	}

	.form {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
	}

	.field-label {
		font-weight: 600;
	}

	.field {
		min-width: 0;
		padding: 9px 12px;
		border: 1px solid var(--line);
		border-radius: 6px;
		font: inherit;
	}

	.field:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.submit {
		padding: 9px 16px;
		border: 0;
		border-radius: 6px;
		background: var(--ink);
		color: #ffffff;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.submit:hover {
		background: #000000;
	}

	.error {
		color: var(--accent);
		font-size: 14px;
	}

	@media (max-width: 640px) {
		.signin {
			padding: 16px;
		}

		.form {
			grid-template-columns: minmax(0, 1fr);
			align-items: stretch;
		}
	}
</style>
