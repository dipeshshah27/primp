// Fathom Jobs: small custom elements used on listing pages.

class JobAlertPrompt extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const query = this.getAttribute('query') || 'these';
    const place = this.getAttribute('place') || 'your area';
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { display: block; margin: 0 0 16px; }
        .box { display: grid; grid-template-columns: 1fr auto; gap: 8px 16px; align-items: center; padding: 16px 18px; border: 1px solid #b6d4fe; border-radius: 12px; background: #eef5ff; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #12263f; }
        strong { display: block; font-size: 16px; }
        form { display: flex; gap: 8px; }
        input { width: 230px; height: 40px; padding: 0 12px; border: 1px solid #b6c4d6; border-radius: 8px; font: inherit; }
        button { height: 40px; padding: 0 16px; border: 0; border-radius: 8px; background: #0b5ed7; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
        small { grid-column: 1 / -1; color: #51627a; }
      </style>
      <div class="box" part="box">
        <div><strong>Get new ${query} jobs in ${place} by email</strong>One message a day at most, only when something new is posted.</div>
        <form><input type="email" placeholder="you@example.org" aria-label="Email address"><button type="submit">Create alert</button></form>
        <small>212 people already follow this search.</small>
      </div>`;
    root.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.setAttribute('subscribed', '');
    });
  }
}

class TimeAgo extends HTMLElement {
  connectedCallback() {
    const days = Number(this.getAttribute('days'));
    this.textContent = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : days + ' days ago';
    this.setAttribute('title', this.getAttribute('datetime'));
  }
}

customElements.define('time-ago', TimeAgo);
customElements.define('job-alert-prompt', JobAlertPrompt);
