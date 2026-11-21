import { BigPage } from './pages/Big';
import { HomePage } from './pages/Home';

// Two pages, switched on the pathname. No router: links are plain <a href> full navigations.
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return path === '/big' ? <BigPage /> : <HomePage />;
}
