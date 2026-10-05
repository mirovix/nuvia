import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceKind, serviceGroup, PRESETS } from '../../lib/kinds.js';

test('Microsoft Teams is a first-class messaging service', () => {
  for (const url of [
    'https://teams.microsoft.com/v2/',
    'https://teams.live.com/v2/',
    'https://teams.cloud.microsoft/'
  ]) {
    const service = { name: 'Work', url };
    assert.equal(serviceKind(service), 'teams');
    assert.equal(serviceGroup(service), 'message');
  }
  assert.deepEqual(PRESETS.find(item => item.name === 'Microsoft Teams'), {
    name: 'Microsoft Teams',
    url: 'https://teams.microsoft.com/v2/'
  });
});
