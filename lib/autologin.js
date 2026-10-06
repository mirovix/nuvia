// Automatic sign-in for services whose session expires (Google Workspace with
// a university SSO, Microsoft 365, …). Runs only for services where the user
// saved credentials in Nuvia; the page script below is serialized with
// Function#toString and executed inside the service page.

// Hosts whose pages are sign-in steps rather than the app itself.
export const SIGN_IN_HOSTS = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com)$|(^|\.)(idp|sso|shibidp|shibboleth|login|auth|cas)[.-]/i;

export function isSignInUrl(url) {
  try { return SIGN_IN_HOSTS.test(new URL(url).hostname); } catch { return false; }
}

// Returns what it did: 'account', 'username', 'password', 'continue', 'mfa', 'none'.
export function fillSignIn(username, secret) {
  const visible = el => {
    if (!el || el.disabled) return false;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const setValue = (input, value) => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const click = el => { el.scrollIntoView?.({ block: 'center' }); for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); };
  const buttons = () => [...document.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(visible);
  const byText = pattern => buttons().find(el => pattern.test((el.innerText || el.value || el.getAttribute('aria-label') || '').trim()));
  const submit = (input, pattern) => {
    const button = byText(pattern) || input.form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (button && visible(button)) click(button);
    else if (input.form) input.form.requestSubmit ? input.form.requestSubmit() : input.form.submit();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  };
  const next = /^(next|avanti|continue|continua|sign in|accedi|log ?in|entra|submit|invia|ok|verify|verifica)$/i;
  const text = (document.body?.innerText || '').toLowerCase();

  // Two-step verification can't be automated: tell the caller.
  if (/verifica in due passaggi|2-step verification|two-step|authenticator|codice di verifica|verification code|approve (the )?sign.?in|approva l'accesso/.test(text) && ![...document.querySelectorAll('input[type="password"]')].some(visible)) return 'mfa';

  // Google account chooser / "choose an account".
  const account = [...document.querySelectorAll('[data-identifier], [data-email]')].find(el => visible(el) && (el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').toLowerCase() === username.toLowerCase());
  if (account) { click(account); return 'account'; }

  const passwordField = [...document.querySelectorAll('input[type="password"]')].find(visible);
  if (passwordField) {
    const user = [...document.querySelectorAll('input[type="email"], input[name*="user" i], input[name*="login" i], input[name="identifier"], input[name="j_username"], input[name="loginfmt"], input[autocomplete="username"]')].find(el => visible(el) && el !== passwordField);
    if (user && !user.value) setValue(user, username);
    const remember = [...document.querySelectorAll('input[type="checkbox"]')].find(el => visible(el) && /remember|ricorda|keep me|resta connesso|mantieni/i.test((el.closest('label')?.innerText || el.parentElement?.innerText || el.name || '')));
    if (remember && !remember.checked) click(remember);
    setValue(passwordField, secret);
    submit(passwordField, next);
    return 'password';
  }

  const user = [...document.querySelectorAll('input[type="email"], input[name="identifier"], #identifierId, input[name="loginfmt"], input[name="j_username"], input[name="username"], input[autocomplete="username"]')].find(visible);
  if (user) { setValue(user, username); submit(user, next); return 'username'; }

  // "Use your face, fingerprint, PIN or security key": take the password route instead.
  if (/face, fingerprint|fingerprint, pin|security key|passkey|volto, impronta|impronta digitale|chiave di sicurezza|windows hello/.test(text)) {
    const other = byText(/^(other ways to sign in|sign in another way|use (your|a) password|use your password instead|try another way|altri modi per accedere|accedi in un altro modo|usa la password|usa una password|prova un altro modo)$/i)
      || [...document.querySelectorAll('a, [role="link"], [role="button"]')].filter(visible).find(el => /other ways|another way|use your password|altri modi|un altro modo|usa la password/i.test(el.innerText || ''));
    if (other) { click(other); return 'continue'; }
  }
  const usePassword = [...document.querySelectorAll('[role="button"], button, a, div[data-value]')].filter(visible).find(el => /^(use (your|my) password|password|usa la (tua )?password)$/i.test((el.innerText || '').trim()));
  if (usePassword && /other ways to sign in|altri modi per accedere|choose a way|scegli (un|il) modo/.test(text)) { click(usePassword); return 'continue'; }

  // Microsoft "Stay signed in?" and similar confirmation pages.
  const stay = document.querySelector('#idSIButton9') || byText(/^(yes|sì|si|continue|continua)$/i);
  if (stay && /stay signed in|rimanere connesso|continue as|continua come|verify it'?s you|verifica che sei tu/.test(text)) { click(stay); return 'continue'; }
  return 'none';
}
