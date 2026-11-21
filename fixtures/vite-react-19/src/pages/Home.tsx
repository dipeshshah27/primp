import { Banner } from '../components/Banner';
import { Features } from '../components/Features';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { Hero } from '../components/Hero';
import { PricingTable } from '../components/PricingTable';

export function HomePage() {
  return (
    <div data-label="home-shell" className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <Header />
      <Banner />
      <main data-label="main" className="mx-auto w-full max-w-5xl flex-1 px-4 pb-16">
        <Hero />
        <Features />
        <PricingTable />
      </main>
      <Footer />
    </div>
  );
}
