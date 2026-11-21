<footer class="site-footer" data-label="site-footer">
	<p class="note" data-label="footer-note">Plumb &amp; Level is a made-up joinery shop used as a test page.</p>
	<a class="link" href="/about" data-label="footer-link">How we work</a>
</footer>

<style>
	.site-footer {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--gap);
		padding: 20px var(--gap);
		border-top: 1px solid var(--line);
		color: var(--ink-soft);
		font-size: 14px;
	}

	.link:hover {
		text-decoration-thickness: 2px;
	}

	@media (max-width: 640px) {
		.site-footer {
			flex-direction: column;
			gap: 6px;
		}
	}
</style>
