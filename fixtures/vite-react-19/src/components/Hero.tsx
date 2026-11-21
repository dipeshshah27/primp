import styles from './Hero.module.css';

// Copy column: Tailwind utilities. Art column: CSS module, plus one Tailwind utility on the
// same element (hero-art) so a single element is styled by two systems at once.
export function Hero() {
  return (
    <section data-label="hero" className="grid items-center gap-8 py-12 md:grid-cols-2">
      <div data-label="hero-copy">
        <h1 data-label="hero-title" className="text-4xl font-bold tracking-tight text-slate-900 md:text-5xl">
          Ship the layout you meant to ship
        </h1>
        <p data-label="hero-subtitle" className="mt-4 text-lg text-slate-600">
          Edit the running page, hand the changes to your coding agent, then check what it actually did.
        </p>
        <div data-label="hero-actions" className="mt-6 flex flex-wrap gap-3">
          <a
            data-label="hero-cta-primary"
            href="#pricing"
            className="rounded-lg bg-indigo-600 px-5 py-2.5 font-semibold text-white hover:bg-indigo-500"
          >
            Start free
          </a>
          <a
            data-label="hero-cta-secondary"
            href="#features"
            className="rounded-lg border border-slate-300 px-5 py-2.5 font-semibold text-slate-700 hover:bg-slate-100"
          >
            See features
          </a>
        </div>
      </div>
      <div data-label="hero-art" className={`${styles.art} shadow-lg`} aria-hidden="true">
        <div data-label="hero-art-bar" className={styles.bar} />
        <div className={styles.row} />
        <div className={styles.row} />
        <div className={styles.rowShort} />
      </div>
    </section>
  );
}
