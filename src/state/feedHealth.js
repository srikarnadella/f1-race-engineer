// Is the telemetry arriving, how fast, and how much of it is lost on the way?
// Read from Car Telemetry, sent once per send-rate step: its overall frame
// counter (which, unlike frameIdentifier, doesn't rewind on a flashback)
// moves 1 frame between packets at 60 Hz, 3 at 20 Hz. A step of twice the
// usual is one packet lost. Over localhost no real race lost one; over
// Wi-Fi from a console it can.
const { median } = require('./race');

const WINDOW_MS = 10000;
// No packet for this long is the game paused or in a menu, not loss: start over.
const PAUSE_MS = 2000;

function createFeedHealth(clock) {
  let arrivals = []; // { at, step }: step = frames since the previous packet
  let lastFrame = null;
  let lastAt = null;

  function record(header) {
    const at = clock();
    const frame = header.overallFrameIdentifier;
    if (lastAt != null && (at - lastAt > PAUSE_MS || frame <= lastFrame)) arrivals = [];
    arrivals.push({ at, step: arrivals.length ? frame - lastFrame : null });
    lastFrame = frame;
    lastAt = at;
    while (arrivals[0].at < at - WINDOW_MS) arrivals.shift();
  }

  // { rateHz, lossPct } over the last 10 s; nulls when there's nothing to read.
  function view() {
    if (arrivals.length < 2 || clock() - lastAt > PAUSE_MS) return { rateHz: null, lossPct: null };
    const steps = arrivals.slice(1).map((a) => a.step);
    const usual = Math.max(1, median(steps));
    const missing = steps.reduce((n, s) => n + Math.max(0, Math.round(s / usual) - 1), 0);
    const spanS = (lastAt - arrivals[0].at) / 1000;
    return {
      rateHz: spanS > 0 ? Math.round(((arrivals.length - 1) / spanS) * 10) / 10 : null,
      lossPct: Math.round((1000 * missing) / (steps.length + missing)) / 10,
    };
  }

  return { record, view };
}

module.exports = { createFeedHealth };
