// What the dashboard's scripts put on window, for the type check only (npm run typecheck).
interface Window {
  RaceWidgets: any;
  RaceAsk: any;
  RaceVoice: any;
  SpeechRecognition?: any;
  webkitSpeechRecognition?: any;
  RaceDebrief: any;
  RaceDesktop?: any;
  // Only in the desktop app window (desktop/preload.js).
  undercut?: any;
}
