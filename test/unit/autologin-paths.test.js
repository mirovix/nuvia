import test from 'node:test';
import assert from 'node:assert/strict';
import { isSignInUrl } from '../../lib/autologin.js';

test('sign-in pages are found by host or by path', () => {
  for (const url of ['https://accounts.google.com/v3/signin', 'https://shibidp.cca.unipd.it/idp/profile', 'https://ras.papercept.net/conferences/scripts/login.pl',
    'https://example.org/users/sign_in', 'https://example.org/signin?next=/', 'https://example.org/auth/login', 'https://example.org/cas/login']) assert.ok(isSignInUrl(url), url);
  for (const url of ['https://ras.papercept.net/conferences/scripts/start.pl', 'https://mail.google.com/mail/u/0/#inbox', 'https://teams.cloud.microsoft/v2/',
    'https://example.org/oauth2-docs', 'https://example.org/author/blog', 'https://example.org/castle']) assert.ok(!isSignInUrl(url), url);
});
