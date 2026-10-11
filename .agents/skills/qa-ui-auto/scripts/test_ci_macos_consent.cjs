const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'ci_macos_consent.js'), 'utf8'), context);
const { fixtureNetworkPrompt } = context.module.exports;
test('recognizes the observed Python local network dialog only', () => {
  const observed = 'Allow “Python” to find devices on local networks? This will allow the app to discover, connect to, and collect data from devices on your networks.';
  assert.equal(fixtureNetworkPrompt('UserNotificationCenter', observed), true);
  for (const [owner, text] of [
    ['Taomni QA', observed],
    ['UserNotificationCenter', observed.replace('Python', 'Taomni QA')],
    ['UserNotificationCenter', 'Allow Python to use the microphone?'],
    ['UserNotificationCenter', 'Allow Python to record your screen?'],
    ['UserNotificationCenter', 'Allow Python access to your files?'],
  ]) assert.equal(fixtureNetworkPrompt(owner, text), false);
});
