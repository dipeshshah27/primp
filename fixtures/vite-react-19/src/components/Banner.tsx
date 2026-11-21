import { useState } from 'react';

// Announcement strip between the header and <main>. Removing or hiding it moves everything
// below it, which makes it a convenient side-effect source. Styled by plain CSS (site.css).
export function Banner() {
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <aside data-label="banner" className="banner" role="note">
      <p data-label="banner-text" className="banner__text">
        <strong data-label="banner-badge" className="banner__badge">
          New
        </strong>
        Verification reports now list the side effects of every edit.
        <a data-label="banner-link" className="banner__link" href="#pricing">
          See plans
        </a>
      </p>
      <button
        data-label="banner-dismiss"
        type="button"
        className="banner__dismiss"
        aria-label="Dismiss announcement"
        onClick={() => setOpen(false)}
      >
        Dismiss
      </button>
    </aside>
  );
}
