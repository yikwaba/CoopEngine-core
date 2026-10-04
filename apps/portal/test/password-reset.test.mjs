import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetTokenFromFragment } from '../src/lib/password-reset.ts';

test('recovery links accept only a complete 256-bit hex fragment', () => {
  const token = 'a'.repeat(64);
  assert.equal(resetTokenFromFragment(`#${token}`), token);
  for (const invalid of ['', token, '#short', `#${token}&next=evil`, `#${'g'.repeat(64)}`, `?token=${token}`]) {
    assert.equal(resetTokenFromFragment(invalid), '');
  }
});
