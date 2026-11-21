import { SessionControl } from './SessionControl';

// Layout uses Tailwind utilities; the nav links are styled by plain CSS (.site-nav in site.css).
export function Header() {
  return (
    <header data-label="header" className="border-b border-slate-200 bg-white">
      <div data-label="header-inner" className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
        <a data-label="header-logo" href="/" className="text-lg font-bold tracking-tight text-indigo-600">
          Lumen
        </a>
        <nav data-label="header-nav" className="site-nav" aria-label="Main">
          <a data-label="nav-features" href="#features">
            Features
          </a>
          <a data-label="nav-pricing" href="#pricing">
            Pricing
          </a>
          <a data-label="nav-big" href="/big">
            Big list
          </a>
        </nav>
        <SessionControl />
      </div>
    </header>
  );
}
