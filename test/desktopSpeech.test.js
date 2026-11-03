const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startRecognizer, grammarPhrases } = require('../desktop/speech');

test('desktop speech: the phrase list keeps custom commands, cleaned, without repeats', () => {
  const p = grammarPhrases(['Status!', 'gap behind', 'x', 'a'.repeat(60)]);
  assert.ok(p.includes('status'));
  assert.strictEqual(p.filter((x) => x === 'gap behind').length, 1);
  assert.ok(!p.includes('x') && !p.some((x) => x.length > 40));
});

// Windows speaks the questions into a file and its recognizer hears them back.
test('desktop speech: the Windows recognizer hears spoken questions through the grammar', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wav = path.join(dir, 'q.wav');
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav}'); $s.Speak('Engineer, gap behind?'); $s.Speak('When do I box?'); $s.Speak('Status'); $s.Dispose()`]);
  const lines = [];
  const rec = startRecognizer({ phrases: grammarPhrases(['status']), wav, onLine: (m) => lines.push(m) });
  await rec.exited;
  if (lines.some((l) => l.error === 'no-recognizer')) return t.skip('no speech recognizer installed');
  const heard = lines.filter((l) => l.text).map((l) => l.text.toLowerCase());
  assert.deepStrictEqual(heard, ['engineer gap behind', 'when do i box', 'status'], JSON.stringify(lines));
});
