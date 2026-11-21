// Layout uses Tailwind utilities; the link list is styled by plain CSS (.footer-links).
export function Footer() {
  return (
    <footer data-label="footer" className="border-t border-slate-200 bg-white">
      <div
        data-label="footer-inner"
        className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6 text-sm text-slate-500 md:flex-row md:items-center md:justify-between"
      >
        <p data-label="footer-copy">Lumen is fixture content for reglet tests, not a real product.</p>
        <ul data-label="footer-links" className="footer-links">
          <li>
            <a data-label="footer-privacy" href="#privacy">
              Privacy
            </a>
          </li>
          <li>
            <a data-label="footer-terms" href="#terms">
              Terms
            </a>
          </li>
        </ul>
      </div>
    </footer>
  );
}
