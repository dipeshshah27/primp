import { useState } from 'react';

// Login simulation. There is no backend: "signing in" writes the cookie session=abc, and the
// signed-in state is read back from document.cookie when the component first renders.
const SESSION_COOKIE = 'session=abc';

function hasSessionCookie(): boolean {
  return document.cookie.split('; ').includes(SESSION_COOKIE);
}

export function SessionControl() {
  const [signedIn, setSignedIn] = useState(hasSessionCookie);

  function toggle() {
    document.cookie = signedIn ? 'session=; path=/; max-age=0' : `${SESSION_COOKIE}; path=/; SameSite=Lax`;
    setSignedIn(hasSessionCookie());
  }

  return (
    <div data-label="session" className="ml-auto flex items-center gap-3 text-sm">
      <span
        data-label="session-status"
        data-session={signedIn ? 'in' : 'out'}
        className={signedIn ? 'w-20 text-right font-medium text-emerald-700' : 'w-20 text-right text-slate-500'}
      >
        {signedIn ? 'Signed in' : 'Signed out'}
      </span>
      <button
        type="button"
        onClick={toggle}
        className="w-20 rounded-md bg-indigo-600 py-1.5 font-medium text-white hover:bg-indigo-500"
        data-label="login-button"
      >
        {signedIn ? 'Sign out' : 'Sign in'}
      </button>
    </div>
  );
}
