import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VERSION } from '../shared/version.js';

test('версия клиента совпадает с package.json и desktop/package.json', () => {
  for (const f of ['package.json', 'desktop/package.json']) {
    assert.equal(JSON.parse(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')).version, VERSION, f);
  }
});
