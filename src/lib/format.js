// How numbers are said on the radio and the call: "3 laps", "1:05", "0.326".

const laps = (n) => `${n} lap${n === 1 ? '' : 's'}`;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s)) % 60).padStart(2, '0')}`;
const thousandths = (ms) => (Math.abs(ms) / 1000).toFixed(3);

module.exports = { laps, clock, thousandths };
