import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './styles/site.css';
import { App } from './App';

// StrictMode is on by default, as in the stock Vite template. Append ?nostrict to any URL to
// render without it: StrictMode renders every component twice in development, which doubles
// the number of elements React creates and changes which of them keep an owner stack on /big.
const strict = !new URLSearchParams(window.location.search).has('nostrict');
const app = <App />;

createRoot(document.getElementById('root')!).render(strict ? <StrictMode>{app}</StrictMode> : app);
