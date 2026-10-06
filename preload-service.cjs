// Preload for service pages. It does nothing except on sign-in pages, where it
// passes what you submit (username, password) to Nuvia so the service can be
// signed back in automatically when its session expires. It runs in an
// isolated world: the page cannot see or call it.
const { contextBridge, ipcRenderer } = require('electron');

const SIGN_IN_HOSTS = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com)$|(^|\.)(idp|sso|shibidp|shibboleth|login|auth|cas)[.-]/i;

if (SIGN_IN_HOSTS.test(location.hostname)) {
  // Sign in with the password, not "face, fingerprint, PIN or security key": with
  // no passkey support on the page, Microsoft and Google ask for the password,
  // which Nuvia can fill in again when the session expires.
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        const refuse = () => Promise.reject(new DOMException('Passkeys are turned off in Nuvia: use your password.', 'NotAllowedError'));
        try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true, writable: true }); } catch {}
        const credentials = navigator.credentials;
        if (credentials) {
          const get = credentials.get.bind(credentials);
          const create = credentials.create.bind(credentials);
          credentials.get = options => (options && options.publicKey ? refuse() : get(options));
          credentials.create = options => (options && options.publicKey ? refuse() : create(options));
        }
      }
    });
  } catch {}
  const USER_FIELDS = 'input[type="email"], input[name="identifier"], #identifierId, input[name="loginfmt"], input[name="j_username"], input[name="username"], input[name*="user" i], input[autocomplete="username"]';
  let last = '';
  const capture = () => {
    const password = [...document.querySelectorAll('input[type="password"]')].find(input => input.value);
    const username = [...document.querySelectorAll(USER_FIELDS)].find(input => input.value && input.type !== 'password');
    if (!password && !username) return;
    const key = `${username?.value || ''}\u0000${password?.value || ''}`;
    if (key === last) return;
    last = key;
    ipcRenderer.send('nuvia:signin-capture', { username: username?.value || '', password: password?.value || '' });
  };
  // Capture phase: runs before the page's own handlers can navigate away.
  document.addEventListener('submit', capture, true);
  document.addEventListener('click', event => { if (event.target.closest?.('button, input[type="submit"], [role="button"]')) capture(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Enter') capture(); }, true);
}
