const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open, raceSnapshots } = require('./helpers/dashboard');

// A characterization test (roadmap Q8): what every dashboard screen draws at set moments of the synthetic race,
// as a hash of its HTML. It pins today's output so the big files can be split with no change in behavior. A
// change that is meant to alter the screens updates the file: UPDATE_GOLDEN=1 node --test test/dashboardGolden.test.js
const FILE = path.join(__dirname, 'golden', 'dashboard-render.json');
const SCREENS = ['1', '2', '3', '4', '5', '6'];
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

test('golden: every dashboard screen draws the same HTML at set moments of the synthetic race', (t) => {
  const snaps = raceSnapshots();
  const picks = Array.from({ length: 12 }, (_, k) => Math.floor((snaps.length - 1) * (k + 1) / 13));
  const got = {};
  const app = open(t);
  app.connect();
  for (const key of SCREENS) {
    // The Debrief is listed once the session is over.
    if (key === '6') app.send({ ...snaps[picks[0]], connected: true, focus: { screen: 'debrief', reason: 'Session over' } });
    app.press(key);
    for (const i of picks) {
      app.send({ ...snaps[i], connected: true });
      got[`${key}@${i}`] = hash(app.window.document.querySelector('main').innerHTML);
    }
  }
  assert.deepStrictEqual(app.errors, []);
  if (process.env.UPDATE_GOLDEN) {
    fs.writeFileSync(FILE, JSON.stringify(got, null, 1) + '\n');
    return;
  }
  const want = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const changed = Object.keys(want).filter((k) => want[k] !== got[k]);
  assert.deepStrictEqual(changed, [], `${changed.length} screen draws changed`);
  assert.deepStrictEqual(Object.keys(got), Object.keys(want));
});
