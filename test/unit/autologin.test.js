import test from 'node:test';
import assert from 'node:assert/strict';
import { fullUsername, isSignInUrl } from '../../lib/autologin.js';

test('UniPD and Google sign-in pages are recognised', () => {
  assert.ok(isSignInUrl('https://shibidp.cca.unipd.it/idp/profile/SAML2/Redirect/SSO?execution=e1s2'));
  assert.ok(isSignInUrl('https://accounts.google.com/v3/signin/identifier?hd=studenti.unipd.it'));
  assert.ok(!isSignInUrl('https://mail.google.com/mail/u/0/#inbox'));
});

test('fullUsername: the domain picked on the page completes a short username', () => {
  assert.equal(fullUsername('mario.rossi', { domain: '@studenti.unipd.it' }), 'mario.rossi@studenti.unipd.it');
  assert.equal(fullUsername('mario.rossi', { domain: '@unipd.it' }), 'mario.rossi@unipd.it');
  assert.equal(fullUsername(' mario.rossi ', { domain: '@EXT.unipd.it' }), 'mario.rossi@ext.unipd.it');
});

test('fullUsername: a full address is kept as typed, whatever the picker says', () => {
  assert.equal(fullUsername('mario.rossi@studenti.unipd.it', { domain: '@unipd.it' }), 'mario.rossi@studenti.unipd.it');
  assert.equal(fullUsername('mario.rossi@unipd.it', { domain: '@studenti.unipd.it' }), 'mario.rossi@unipd.it');
});

test('fullUsername: without a picker, the email typed at Google just before completes it', () => {
  assert.equal(fullUsername('mario.rossi', { pending: 'Mario.Rossi@studenti.unipd.it' }), 'Mario.Rossi@studenti.unipd.it');
  assert.equal(fullUsername('mario.rossi', { pending: 'other.person@studenti.unipd.it' }), 'mario.rossi');
  assert.equal(fullUsername('3457362', {}), '3457362');
  assert.equal(fullUsername('mario.rossi', { domain: 'on' }), 'mario.rossi', 'a radio value that is not a domain is ignored');
  assert.equal(fullUsername('', { domain: '@unipd.it' }), '');
});
