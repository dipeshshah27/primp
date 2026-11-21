<script lang="ts">
	import { enhance } from '$app/forms';

	let { user }: { user: string } = $props();
</script>

<!-- Rendered only while signed in (the session cookie is set). -->
<section class="account" id="signin" data-label="account">
	<h2 class="heading" data-label="account-title">Welcome back, {user}</h2>
	<p class="note" data-label="account-note">The session cookie is set, so this card replaces the sign-in form.</p>

	<form method="POST" action="?/signout" use:enhance data-label="signout-form">
		<button class="signout" type="submit" data-label="signout-submit">Sign out</button>
	</form>
</section>

<style>
	.account {
		display: grid;
		justify-items: start;
		gap: 12px;
		padding: 24px;
		border: 1px solid var(--ok);
		border-radius: var(--radius);
		background: #f0f7f3;
	}

	.heading {
		font-size: 22px;
	}

	.note {
		color: var(--ink-soft);
	}

	.signout {
		padding: 9px 16px;
		border: 1px solid var(--ink);
		border-radius: 6px;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.signout:hover {
		background: var(--ink);
		color: #ffffff;
	}

	@media (max-width: 640px) {
		.account {
			padding: 16px;
		}
	}
</style>
