const test = require('node:test');
const assert = require('node:assert/strict');
const { retryDelay } = require('../src/retry');

test('reconnection attempts slow down while OBS stays closed', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(retryDelay), [5000, 10000, 30000, 60000, 120000]);
  assert.equal(retryDelay(50), 120000);
  assert.equal(retryDelay(-1), 5000);
});
