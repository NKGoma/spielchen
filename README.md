# spielchen

A 30-minute party board game for 3–6 players around a TV. Roll, land on a colour, and act, draw, explain or answer.

Static site: plain HTML/CSS/ES modules, no build step, no backend. Open `index.html` through any static server, or use GitHub Pages.

## Status

- **Milestone 1 — playable on the laptop (hot-seat): done.** Board, rules, turn flow, keyboard controls, 96-card backup deck, timers, Last Orders, winner screen.
- Milestone 2 — phone remote (PeerJS): next.
- Milestone 3 — fresh LLM decks.
- Milestone 4 — polish.

## How Brains works

The question appears on the TV for everyone, and the active player answers. A **quizmaster** sees the answer and judges:
- free-for-all: the previous player
- teams: someone from another team

If the answer is wrong, others can steal. The answer is never shown to the person answering. In Milestone 2 the phone goes to the quizmaster for Brains cards.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening the file directly with `file://` won't work, because ES modules and `fetch` need a server.)

## Keys (hot-seat)

| Key | Action |
| --- | --- |
| Enter | Start the game (setup) |
| Space | Roll · peek at the card (6 s) · start the timer |
| Y / N | Got it / Failed (Brains: the quizmaster presses Correct / Wrong) |
| 1–6 | Pick a player (guesser, stealer, All Play winner) · 1–4 pick a category |
| 0 | Nobody |
| P | Peek at the card again before the timer starts |
| U | Undo the last result (before the next roll) |
| Esc | Back from a player pick |
| F / M / H | Fullscreen / mute / hot-seat toggle |
| D, number, Enter | Debug: jump the active token to that square |

## Tests

```bash
node tests/rules.test.mjs
```

## Deploy to GitHub Pages

Settings → Pages → Source: deploy from branch `main`, folder `/ (root)`. Then open `https://<user>.github.io/spielchen/`.
