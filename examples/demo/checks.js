import assert from 'node:assert/strict';
import { normalizeNote } from './notes.js';

assert.equal(normalizeNote('  Ship it  '), 'Ship it');
assert.equal(normalizeNote('   '), '');
assert.equal(normalizeNote('x'.repeat(250)).length, 200);
console.log('PASS: trims notes, rejects blank notes, and limits note length.');
