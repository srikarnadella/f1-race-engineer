# Undercut

**A race engineer for F1 26.** It reads the game's live telemetry and tells you one thing at a time:
when to box, who to attack, when the rain is coming. You watch it on a phone or tablet next to your
screen, and it can read the calls out loud.

I built it because the in-game engineer doesn't tell you much, and everything it would need is
already in the data the game sends out. It's a student project: free, open source, and everything
runs on your own PC.

**[▶ Try the demo in your browser](https://srikarnadella.github.io/f1-race-engineer/)**: the real
dashboard replaying a race I recorded at Monaco. No install needed.

![The Drive screen: the call, the cars either side, the radio and four projections](docs/screenshots/drive.png)

| Battle | Strategy | Weather | Debrief |
|---|---|---|---|
| ![Battle](docs/screenshots/battle.png) | ![Strategy](docs/screenshots/strategy.png) | ![Weather](docs/screenshots/weather.png) | ![Debrief](docs/screenshots/debrief.png) |

## How it fits together

```mermaid
flowchart LR
    GAME["F1 26<br/>(PC or console)"] -->|"telemetry over Wi-Fi<br/>(UDP, ~330 packets a second)"| BRIDGE["Undercut on your PC<br/>works out the calls"]
    BRIDGE -->|"one update, 10 times a second"| SCREEN["Any browser<br/>phone, tablet, laptop"]
    BRIDGE --> STORE["Saved races<br/>for the debrief"]
```

The game already sends data for **every car**, not just yours. Undercut keeps track of all of it,
works out things like pit loss, tyre wear and who is about to stop, and turns that into one call:
**PUSH, HOLD or BOX**, plus short radio messages ("Defend from Albon, watch turn 1").

## Try it

You need [Node.js](https://nodejs.org) 18.3 or newer.

```bash
git clone https://github.com/srikarnadella/f1-race-engineer.git
cd f1-race-engineer
npm install
npm run demo        # a made-up five-lap race, no game needed
```

Then open **http://localhost:8080**. Keys **1–6** switch screens.

**With the game:** run `npm start` instead, then in F1 26 go to *Settings → Telemetry Settings* and
turn **UDP Telemetry On** (port **20777**, format **2025** or later). Scan the QR code it prints with
your phone or tablet. Full steps, options and voice setup: [docs/setup.md](docs/setup.md).

## Does it actually work?

I recorded six races in F1 26 and replayed them through the engine, scoring each prediction against
what really happened, next to the obvious guess:

| Prediction | Undercut | Obvious guess |
|---|---|---|
| Tyre wear per lap (1,264 laps) | **342 ms off** | 485 ms ("no wear") |
| Where you rejoin after a stop (24 stops) | **2.54 places off** | 4.33 ("keep your place") |
| A rival's battery at the line | **7.7 points off** | 13.2 ("stays where it is") |
| Will the car behind pass in 10 s? | 0.851 AUC | 0.854 (gap only), so it's a tie |

Three of the six models I score beat the obvious guess and three don't yet, and the app says so
instead of pretending. Every number is in [docs/accuracy.md](docs/accuracy.md).

## Read more

| | |
|---|---|
| [Setup](docs/setup.md) | Using it with the game, options, voice on a tablet, recording a race |
| [The dashboard](docs/dashboard.md) | Every screen, voice questions, and everything it works out for you |
| [Models and accuracy](docs/models.md) | The machine learning, how it's scored, the calls audit, lap compare |
| [How it's built](docs/development.md) | The architecture, the tests, and every command |
| [Status and what's next](docs/status.md) | What's verified, what's still open, and what I'm building next |
| [One call, end to end](docs/how-it-works.md) | A single call followed through the code |
| [Saved race data](docs/race-store.md) | The SQL tables every session is kept in |
| [Roadmap](docs/roadmap.md) | The work plan, and what the tests found |

## Built with

Node.js (no framework, no build step), WebSockets, SQLite, and plain HTML/CSS/JavaScript for the
dashboard. The models are written from scratch. 260+ tests run on every push.

Fan project. Not affiliated with Formula 1, the FIA or Electronic Arts. MIT license.
