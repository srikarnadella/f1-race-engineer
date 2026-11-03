// Voice questions in the desktop window. Electron has the browser's speech
// synthesis (the engineer's voice works as is) but not its recognition, which
// is a Google service only Chrome itself can use. So the app listens with the
// recognizer built into Windows instead: offline, nothing sent anywhere, and
// steered by a grammar of the questions it knows ("Engineer, gap behind?"),
// which it hears far more reliably than free dictation - dictation is only the
// fallback for anything else. It runs in a PowerShell child process (System.Speech)
// that prints one JSON line per utterance: { text, alternates, confidence }, or
// { text: null } after a few seconds of silence, or { error }.
const { spawn } = require('child_process');
const readline = require('readline');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.Speech } catch { [Console]::Out.WriteLine('{"error":"no-speech"}'); exit 1 }
if (-not [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers().Count) { [Console]::Out.WriteLine('{"error":"no-recognizer"}'); exit 1 }
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$phrases = @(($env:UNDERCUT_PHRASES -split "\n") | Where-Object { $_ })
if ($phrases.Count) {
  $gb = New-Object System.Speech.Recognition.GrammarBuilder
  $gb.Append('engineer', 0, 1)
  $gb.Append((New-Object System.Speech.Recognition.Choices -ArgumentList (,[string[]]$phrases)))
  $r.LoadGrammar((New-Object System.Speech.Recognition.Grammar -ArgumentList $gb))
  $r.LoadGrammar((New-Object System.Speech.Recognition.Grammar -ArgumentList (New-Object System.Speech.Recognition.GrammarBuilder -ArgumentList 'engineer')))
}
$d = New-Object System.Speech.Recognition.DictationGrammar
$d.Weight = 0.2
$r.LoadGrammar($d)
$wav = $env:UNDERCUT_SPEECH_WAV
if ($wav) { $r.SetInputToWaveFile($wav) } else {
  try { $r.SetInputToDefaultAudioDevice() } catch { [Console]::Out.WriteLine('{"error":"no-microphone"}'); exit 1 }
}
$r.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $res = $null
  try { $res = $r.Recognize() } catch { if ($wav) { break } }
  if ($res) {
    $alt = @($res.Alternates | ForEach-Object { $_.Text })
    [Console]::Out.WriteLine((@{ text = $res.Text; alternates = $alt; confidence = $res.Confidence } | ConvertTo-Json -Compress))
  } elseif ($wav) { break } else { [Console]::Out.WriteLine('{"text":null}') }
}
`;

// Below this the recognizer is guessing at noise ("of the puppet of the", 0.04):
// a real question scores 0.5-0.95, so a guess is dropped and it keeps listening.
const MIN_CONFIDENCE = 0.25;

// onLine(msg): every parsed line, guesses dropped. phrases: what the grammar listens for.
// wav: a recording to listen to instead of the microphone (tests).
function startRecognizer({ phrases = [], onLine, wav = null }) {
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    env: { ...process.env, UNDERCUT_PHRASES: phrases.join('\n'), UNDERCUT_SPEECH_WAV: wav || '' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // PowerShell chatter
    }
    if (msg.text && !(msg.confidence >= MIN_CONFIDENCE)) return;
    onLine(msg);
  });
  child.on('error', () => onLine({ error: 'no-speech' }));
  return { stop: () => child.kill(), exited: new Promise((resolve) => child.on('exit', resolve)) };
}

// The phrases the grammar knows: the Ask questions as people say them, and
// any custom commands. Lowercase, letters and spaces only.
const BASE_PHRASES = [
  'gap behind', "who's behind", 'gap ahead', "who's ahead", 'when do i box', 'when should i box', 'when do i pit', 'box',
  'how are my tyres', 'tyres', 'battery', 'how much battery', 'is it going to rain', 'rain', 'weather', 'fuel', 'how much fuel',
  'laps left', 'how many laps left', "what's the call", 'what is the call', 'the call', 'strategy',
  'how bad is the damage', 'damage', 'any penalties', 'penalties', 'track limits', 'last lap', 'best lap', 'pace',
];
const cleanPhrase = (p) => String(p || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').trim().replace(/\s+/g, ' ');
const grammarPhrases = (custom = []) => [...new Set([...BASE_PHRASES, ...custom.map(cleanPhrase)].filter((p) => p.length >= 2 && p.length <= 40))];

module.exports = { startRecognizer, grammarPhrases };
