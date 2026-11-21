// What a dev server's client does with a CSS module: it arrives as JavaScript and is put into
// the document as a <style> element, here after the page has already painted.
const style = document.createElement('style');
style.setAttribute('type', 'text/css');
style.setAttribute('data-vite-dev-id', '/src/styles/hero.css');
style.textContent = '#hero { padding: 48px 0; }';
document.head.appendChild(style);
