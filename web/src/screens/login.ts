/**
 * Login screen — SPEC.md §9.1. Username, password, one button. No other chrome.
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
      <form class="login-form" novalidate>
        <div class="form-field">
          <label for="login-username">Username</label>
          <input id="login-username" name="username" type="text" autocomplete="username"
                 autocapitalize="off" autocorrect="off" spellcheck="false" required />
        </div>
        <div class="form-field">
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password"
                 autocomplete="current-password" required />
        </div>
        <p class="login-error" role="alert" hidden></p>
        <button type="submit" class="btn btn-primary btn-lg login-submit">Log in</button>
      </form>
    </div>
  `;
  root.appendChild(wrap);

  const form = wrap.querySelector('.login-form') as HTMLFormElement;
  const usernameInput = wrap.querySelector('#login-username') as HTMLInputElement;
  const passwordInput = wrap.querySelector('#login-password') as HTMLInputElement;
  const errorEl = wrap.querySelector('.login-error') as HTMLParagraphElement;
  const submitBtn = wrap.querySelector('.login-submit') as HTMLButtonElement;

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
      window.location.hash = '#/';
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        showError('Incorrect username or password.');
      } else if (err instanceof ApiError) {
        showError(err.message);
      } else {
        showError("Couldn't reach the server. Check your connection and try again.");
      }
      setBusy(false);
      passwordInput.focus();
    }
  }

  const onSubmit = (e: SubmitEvent): void => void handleSubmit(e);
  form.addEventListener('submit', onSubmit);
  usernameInput.focus();

  return () => {
    form.removeEventListener('submit', onSubmit);
  };
}
