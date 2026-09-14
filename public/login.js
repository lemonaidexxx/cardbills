'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let busy = false;
  async function request(path, body) {
    const response = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Try again.');
    return data;
  }
  async function action(fn) {
    if (busy) return;
    busy = true; $('auth-status').textContent = '';
    document.querySelectorAll('button').forEach(b => b.disabled = true);
    try { await fn(); } catch (error) { $('auth-status').textContent = error.message; }
    finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
  }
  async function load() {
    const state = await request('session');
    if (state.complete) { location.replace('/app'); return; }
    $('login-form').hidden = state.signedIn;
    $('restart').hidden = !state.signedIn;
    $('mfa-form').hidden = true; $('enrollment').hidden = true; $('start-enrollment').hidden = true;
    if (!state.signedIn) { $('username').focus(); return; }
    $('auth-title').textContent = 'Verify your sign-in';
    $('auth-description').textContent = 'Enter the code from your authenticator.';
    $('factor').replaceChildren();
    if (state.factors?.length) {
      for (const factor of state.factors) $('factor').append(new Option(factor.label, factor.id));
      $('mfa-form').hidden = false; $('otp').focus();
    } else if (state.enrollmentAllowed) {
      $('auth-title').textContent = 'Set up your authenticator';
      $('auth-description').textContent = 'Register your authenticator to protect this workspace.';
      $('start-enrollment').hidden = false;
    } else {
      $('auth-status').textContent = 'Enable owner enrollment in the deployment settings to register your authenticator.';
    }
  }
  $('login-form').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      const password = $('password').value;
      $('password').value = '';
      await request('login', { username: $('username').value, password });
      await load();
    });
  });
  $('mfa-form').addEventListener('submit', event => {
    event.preventDefault();
    action(async () => {
      const code = $('otp').value; $('otp').value = '';
      const result = await request('verify', { factorId: $('factor').value, code });
      $('secret').textContent = ''; $('qr').removeAttribute('src');
      location.replace(result.next);
    });
  });
  $('start-enrollment').addEventListener('click', () => action(async () => {
    const factor = await request('enroll', {});
    const svg = typeof factor.qr === 'string' && factor.qr.startsWith('<svg') ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(factor.qr) : factor.qr;
    if (typeof svg !== 'string' || !svg.startsWith('data:image/svg+xml')) throw Error('Authenticator QR data needs review.');
    $('qr').src = svg; $('secret').textContent = factor.secret;
    $('factor').replaceChildren(new Option('Cardbills authenticator', factor.id));
    $('enrollment').hidden = false; $('mfa-form').hidden = false; $('start-enrollment').hidden = true;
    $('otp').focus();
  }));
  $('restart').addEventListener('click', () => action(async () => { await request('logout', {}); location.replace('/login.html'); }));
  $('show-password').addEventListener('click', () => {
    const show = $('password').type === 'password';
    $('password').type = show ? 'text' : 'password';
    $('show-password').textContent = show ? 'Hide' : 'Show';
    $('show-password').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  window.addEventListener('pagehide', () => { $('password').value = ''; $('otp').value = ''; $('secret').textContent = ''; $('qr').removeAttribute('src'); });
  action(load);
})();
