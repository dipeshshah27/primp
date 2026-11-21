// Consent bar, loaded late. It builds its DOM with appendChild and puts it in front of
// everything else in <body>, so the whole page moves down by the height of the bar.
(function () {
  const bar = document.createElement('div');
  bar.id = 'cookie-bar';

  const text = document.createElement('p');
  text.id = 'cookie-text';
  text.textContent = 'We use two cookies: one keeps you signed in and one remembers your home stop.';
  bar.appendChild(text);

  const accept = document.createElement('button');
  accept.id = 'cookie-accept';
  accept.type = 'button';
  accept.textContent = 'Accept';
  bar.appendChild(accept);

  document.body.insertBefore(bar, document.body.firstChild);
})();
