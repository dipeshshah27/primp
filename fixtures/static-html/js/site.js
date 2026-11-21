// Fieldnotes: the only script on the site. Plain DOM APIs, loaded with "defer".
// It changes attributes, classes and text of elements that are already in the HTML;
// it never creates or removes elements.

const PRICE_PER_NOTEBOOK = 14;
const BULK_THRESHOLD = 10;
const BULK_DISCOUNT = 0.15;

/** Total in whole currency units for `count` notebooks; 15% off from ten upwards. */
function estimateTotal(count) {
  const full = count * PRICE_PER_NOTEBOOK;
  return count >= BULK_THRESHOLD ? Math.round(full * (1 - BULK_DISCOUNT)) : full;
}

function setUpMenu() {
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.getElementById('site-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}

function setUpEstimate() {
  const form = document.querySelector('.estimate-form');
  if (!form) return;
  const input = form.querySelector('.estimate-input');
  const total = form.querySelector('.estimate-total');
  const note = document.querySelector('.estimate-note');

  const render = () => {
    const count = Math.max(0, Math.min(500, Math.trunc(Number(input.value)) || 0));
    total.textContent = `${estimateTotal(count)} EUR`;
    note.textContent =
      count >= BULK_THRESHOLD
        ? 'Bulk price applied: 15% off from ten notebooks.'
        : `Order ${BULK_THRESHOLD - count} more for the bulk price.`;
  };

  form.addEventListener('submit', (event) => event.preventDefault());
  input.addEventListener('input', render);
  render();
}

setUpMenu();
setUpEstimate();
document.documentElement.dataset.js = 'ready';
