import Link from 'next/link'
import { ClientFrame } from '@/components/client/ClientFrame'
import { Counter } from '@/components/client/Counter'
import { Newsletter } from '@/components/client/Newsletter'
import { Tabs } from '@/components/client/Tabs'
import { FrameNote } from '@/components/server/FrameNote'
import { StatsPanel } from '@/components/server/StatsPanel'
import styles from './page.module.css'

export default function HomePage() {
  return (
    <>
      <section data-label="home-hero" className={styles.hero}>
        <h1 data-label="home-title">Edit it visually, verify it for real</h1>
        <p data-label="home-lede" className={styles.lede}>
          A small product page used to test a dev proxy against <strong data-label="home-lede-strong">Next.js 16</strong> with Turbopack.
        </p>
        <Link href="/actions" className={styles.cta}>
          <span data-label="home-cta">Try the Server Action</span>
        </Link>
      </section>

      <ul data-label="home-card-grid" className={styles.cardGrid}>
        <li data-label="home-card-edits" className={styles.card}>
          <h2 data-label="home-card-edits-title">Edits</h2>
          <p>Change CSS, hide or remove elements.</p>
        </li>
        <li data-label="home-card-shifts" className={styles.card}>
          <h2 data-label="home-card-shifts-title">Shifts</h2>
          <p>See what moved and which line caused it.</p>
        </li>
        <li
          data-label="home-card-verify"
          className={styles.card}
        >
          <h2 data-label="home-card-verify-title">Verify</h2>
          <p>Re-measure the page after the agent edits the source.</p>
        </li>
      </ul>

      <StatsPanel />

      <div className={styles.columns}>
        <section data-label="home-counter-section" className="panel">
          <h2>Client counter</h2>
          <Counter initial={3} />
        </section>
        <section data-label="home-tabs-section" className="panel">
          <h2>Client tabs</h2>
          <Tabs />
        </section>
      </div>

      <ClientFrame title="Server content in a client frame">
        <FrameNote />
      </ClientFrame>

      <section data-label="home-newsletter-section" className="panel">
        <h2>Client form</h2>
        <Newsletter />
      </section>
    </>
  )
}
