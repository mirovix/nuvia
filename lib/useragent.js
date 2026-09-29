// The user agent real Chrome sends on each OS. Google refuses sign-in ("this
// browser or app may not be secure") when the UA's platform disagrees with the
// client hints Chromium sends (Sec-CH-UA-Platform), or when it carries the full
// version instead of Chrome's reduced "<major>.0.0.0".
const PLATFORMS = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  linux: 'X11; Linux x86_64'
};

export function chromeUserAgent(platform = process.platform, chromeVersion = process.versions.chrome) {
  const major = String(chromeVersion || '').split('.')[0] || '138';
  return `Mozilla/5.0 (${PLATFORMS[platform] || PLATFORMS.linux}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Google's sign-in pages reject embedded Chromium however it presents itself,
// but accept Firefox. Only accounts.google.com sees this identity.
const FIREFOX_PLATFORMS = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10.15',
  linux: 'X11; Linux x86_64'
};
export function firefoxUserAgent(platform = process.platform) {
  return `Mozilla/5.0 (${FIREFOX_PLATFORMS[platform] || FIREFOX_PLATFORMS.linux}; rv:140.0) Gecko/20100101 Firefox/140.0`;
}
// Any page of Google's account site. The whole sign-in flow (including
// ServiceLogin/CheckCookie redirects) must use one identity from start to end.
export const isGoogleSignIn = url => /^https:\/\/accounts\.google\.com(?:[/?#]|$)/i.test(String(url || ''));
