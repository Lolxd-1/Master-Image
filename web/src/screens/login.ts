/**
 * Login screen — SPEC.md §9.1. Username, password, one button, plus a show-password
 * toggle (cracked-phone typo recovery) and a one-line context + support hint so a
 * WhatsApp-link opener knows he is in the right place and what to do when stuck.
 */

import { ApiError } from '../api';
import { store } from '../store';
import type { Cleanup } from '../main';

export function mount(root: HTMLElement): Cleanup {
  const wrap = document.createElement('div');
  wrap.className = 'screen screen-login';

  wrap.innerHTML = `
    <div class="login-card">
      <h1 class="login-title">Stock Picker</h1>
      <p class="login-sub">Tick which products your shop stocks, then get your file for Amazon.</p>
      <form class="login-form" novalidate>
        <div class="form-field">
          <label for="login-username">Username</label>
          <input id="login-username" name="username" type="text" autocomplete="username"
                 autocapitalize="off" autocorrect="off" spellcheck="false" required />
        </div>
        <div class="form-field">
          <label for="login-password">Password</label>
          <div class="password-wrap">
            <input id="login-password" name="password" type="password"
                   autocomplete="current-password" required />
            <button type="button" class="btn" data-action="show-pw" aria-label="Show password" aria-pressed="false">Show</button>
          </div>
        </div>
        <p class="login-error" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary btn-lg login-submit">Log in</button>
      </form>
      <p class="login-support">Problems logging in? Call the person who sent you this link.</p>
    </div>
  `;
  root.appendChild(wrap);

  const form = wrap.querySelector('.login-form') as HTMLFormElement;
  const usernameInput = wrap.querySelector('#login-username') as HTMLInputElement;
  const passwordInput = wrap.querySelector('#login-password') as HTMLInputElement;
  const errorEl = wrap.querySelector('.login-error') as HTMLParagraphElement;
  const submitBtn = wrap.querySelector('.login-submit') as HTMLButtonElement;
  const showPw = wrap.querySelector('[data-action="show-pw"]') as HTMLButtonElement;

  function showError(message: string): void {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function hideError(): void {
    errorEl.hidden = true;
  }

  function setBusy(busy: boolean): void {
    usernameInput.disabled = busy;
    passwordInput.disabled = busy;
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? 'Logging in…' : 'Log in';
  }

  async function handleSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    hideError();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      showError('Enter your username and password.');
      return;
    }

    setBusy(true);
    try {
      await store.login(username, password);
      const next = sessionStorage.getItem('sp:post-login-next');
      sessionStorage.removeItem('sp:post-login-next');
      window.location.hash = next ?? '#/';
      if (window.location.hash === '#/login') window.location.hash = '#/';
      else window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        showError('Incorrect username or password. Check it and try again, or call the person who sent you this link.');
      } else if (err instanceof ApiError) {
        showError(err.message);
      } else {
        showError('No internet. Your work stays on this phone — check your connection and try again.');
      }
      setBusy(false);
      passwordInput.focus();
    }
  }

  const onSubmit = (e: SubmitEvent): void => void handleSubmit(e);
  form.addEventListener('submit', onSubmit);
  const onShowPw = (): void => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    showPw.textContent = show ? 'Hide' : 'Show';
    showPw.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    showPw.setAttribute('aria-pressed', show ? 'true' : 'false');
  };
  showPw.addEventListener('click', onShowPw);
  usernameInput.focus();

  return () => {
    form.removeEventListener('submit', onSubmit);
    showPw.removeEventListener('click', onShowPw);
  };
}
