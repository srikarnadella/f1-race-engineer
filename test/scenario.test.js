const test = require('node:test');
const assert = require('node:assert');
const { syntheticPackets, replay } = require('./helpers/synthetic');

// The synthetic race scripts its causes (src/sim/syntheticSession.js):
// HAMILTON (P6, car 5) pits at the end of lap 15, SAINZ (P8, car 7) on fresh
// softs attacks the player, a VSC comes out at 55% of lap 17, the player's
// tyres wear towards the cliff and the fuel margin shrinks. Each call must
// follow its cause, and none may come before it.
const HAMILTON = 5;
const SAINZ = 7;

let cached = null;
function timeline() {
  if (cached) return cached;
  cached = [];
  replay(syntheticPackets(), {
    onTick: ({ tMs, snap, pipeline }) => {
      const fm = pipeline.fieldModel;
      const me = snap.player && fm.getCar(fm.playerIndex());
      const sainz = fm.getCar(SAINZ);
      if (!me || !me.damage || !sainz.lapData) return; // the first packets
      cached.push({
        t: tMs,
        cards: new Map(snap.insights.map((i) => [i.id, i])),
        call: snap.strategy && snap.strategy.call,
        sc: snap.session && snap.session.safetyCarStatus,
        hamiltonPit: fm.getCar(HAMILTON).lapData.pitStatus,
        // SAINZ behind the player: his interval to the car ahead, when that car is the player.
        sainzBehindMs: sainz.lapData.carPosition === me.lapData.carPosition + 1 ? sainz.lapData.deltaToCarInFrontInMS : null,
        lap: me.lapData.currentLapNum,
        wear: Math.max(...me.damage.tyresWear),
      });
    },
  });
  return cached;
}
const firstWith = (pred) => timeline().find(pred);

test('scenario: the overcut card follows HAMILTON into the pit lane, within 5 s, never before', () => {
  const pitIn = firstWith((f) => f.hamiltonPit !== 0);
  const card = firstWith((f) => [...f.cards.keys()].some((id) => id.startsWith('overcut')));
  assert.ok(pitIn && card);
  assert.ok(card.t >= pitIn.t && card.t - pitIn.t <= 5000, `pit entry ${pitIn.t} ms, card ${card.t} ms`);
  assert.match([...card.cards.values()].find((i) => i.id.startsWith('overcut')).message, /HAMILTON pitted/);
});

test('scenario: the VSC is announced within a second, and the cheap-stop call lives only while it is out', () => {
  const out = firstWith((f) => f.sc === 2);
  const vscCard = firstWith((f) => [...f.cards.values()].some((i) => /Virtual Safety Car deployed/.test(i.message)));
  assert.ok(out && vscCard && Math.abs(vscCard.t - out.t) <= 1000, `VSC ${out && out.t}, card ${vscCard && vscCard.t}`);
  const cheap = timeline().filter((f) => f.cards.has('cheap-stop'));
  assert.ok(cheap.length, 'a cheap stop is offered');
  const ended = timeline().find((f) => f.t > out.t && f.sc === 0);
  for (const f of cheap) assert.ok(f.t >= out.t - 200 && f.t < ended.t + 1000, `cheap-stop at ${f.t} ms, VSC ${out.t}-${ended.t} ms`);
});

test('scenario: no defend call while the VSC is out (no overtaking under it)', () => {
  for (const f of timeline().filter((x) => x.sc === 2)) assert.ok(!f.cards.has('under-attack'), `defend at ${f.t} ms under the VSC`);
});

test('scenario: "defend" only with SAINZ within a second behind', () => {
  const defending = timeline().filter((f) => f.cards.has('under-attack'));
  assert.ok(defending.length, 'SAINZ gets close enough to defend against');
  const first = defending[0];
  assert.ok(first.sainzBehindMs != null && first.sainzBehindMs <= 1000, `first defend call with SAINZ ${first.sainzBehindMs} ms behind`);
  // The forecast comes first: a warning, then the defend call.
  const warn = firstWith((f) => f.cards.has('attack-warning'));
  assert.ok(warn && warn.t < first.t);
});

test('scenario: the tyre warning comes before BOX, and BOX gives the tyres as its reason', () => {
  const warn = firstWith((f) => f.cards.has('tyre-cliff'));
  const box = firstWith((f) => f.call && f.call.action === 'BOX');
  assert.ok(warn && box && warn.t < box.t, `warning ${warn && warn.t}, box ${box && box.t}`);
  assert.match(box.call.reason, /[Tt]yres/);
  assert.ok(box.wear > warn.wear, 'more worn by the time it says box');
});

test('scenario: the call never flickers - no action shown for less than 2 s', () => {
  const runs = [];
  for (const f of timeline()) {
    const a = f.call ? f.call.action : null;
    if (!runs.length || runs[runs.length - 1].a !== a) runs.push({ a, from: f.t, to: f.t });
    else runs[runs.length - 1].to = f.t;
  }
  const short = runs.slice(1, -1).filter((r) => r.to - r.from < 2000);
  assert.deepStrictEqual(short.map((r) => `${r.a} for ${r.to - r.from} ms at ${r.from}`), []);
});

test('scenario: damage reads as the driver says it ("front-left wing"), not a lower-cased label', () => {
  const card = firstWith((f) => f.cards.has('damage:measuring'));
  assert.ok(card, 'the damage card shows');
  assert.match(card.cards.get('damage:measuring').message, /^Damage: front-left wing 12%/);
});
