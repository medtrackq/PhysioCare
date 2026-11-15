const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('btn(): submit buttons keep type="submit" (no duplicate type attribute)', async () => {
  const { btn } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'ui.js')).href);
  const submit = btn('บันทึก', 'type="submit"');
  assert.equal((submit.match(/\btype=/g) || []).length, 1);
  assert.match(submit, /type="submit"/);
  assert.match(btn('ปิด', 'id="x"'), /^<button type="button"/);
});
