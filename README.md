# spielchen

A 30-minute party board game for 2–6 players around a TV. Roll, land on a colour, and act, draw, explain or answer. Claude writes a fresh deck for every game.

It's a static site (plain HTML/CSS/ES modules) with no build step and no backend. It runs straight from GitHub Pages.

## Play

1. Open `https://<user>.github.io/spielchen/` on the laptop connected to the TV. Press **F** for fullscreen.
2. Scan the QR code with one phone, or open `phone.html` on the phone and type the 4-letter code. The dot turns green when the phone is connected.
3. Type the names and press **Start**, on the laptop or on the phone.
4. Pass the phone around. The phone shows the card behind **Hold to peek**. The TV never shows the secret.

**Phone quit or died?** Just open the game page on the phone again. It remembers the room for 6 hours and rejoins by itself. The TV always shows the room code in the top bar, plus a QR card whenever the phone is gone. Any phone can take over.

**No phone?** Press **H** for hot-seat mode. Cards then show on the TV for 6 s behind "Everyone except Lena, look away", and the laptop keys run everything.

### Fresh cards (optional)

Open Settings (the slider icon, top right), paste an Anthropic API key and press **Test key**. The key is stored only in that browser's `localStorage`. It is never sent to the phone or anywhere except `api.anthropic.com`.

- **Tell it what you're into:** on the setup screen (or the phone's lobby), type topics into "What should the cards be about?" (e.g. "90s music, football, less politics") or tap a chip. Claude replies with what it'll write, and the deck is rebuilt around your topics. "Surprise me" lets it choose.
- Saving a key always gives a visible answer: "Key works" or the reason it didn't (rejected, no credit, rate limit…). Saved mid-game, fresh cards swap into the game you're playing.
- Generation starts as soon as the setup screen loads, so the deck is usually ready before the names are typed. "Fresh cards 3/5" shows progress.
- The game never waits: any category that isn't ready plays from the 96-card backup deck, and fresh cards swap in as they arrive.
- Halfway through a game (at most 10 minutes in), the next deck is generated quietly, so **Rematch** is instant.
- The cards you've already seen (the last 400) are avoided in later games.
- Settings also has: model (Haiku 5.5 fast, Sonnet 5.5 better), clean ↔ cheeky, German flavour (0–50%), game length and sound.

## How a turn works

- **Act, Draw, Words:** the active player peeks at the card on the phone, taps Start, then Got it (and picks who guessed) or Failed. In teams, the teammate guesses and the other team can steal on a fail.
- **Brains:** the question is on the TV for everyone, and the active player answers. A **quizmaster** gets the phone with the answer and judges: in free-for-all the previous player, in teams someone from another team. If the answer is wrong, others can steal. The answer is never shown to the person answering.
- **All Play:** public on the TV. Speed Round and Estimate-Off reveal their answers one step at a time.

## Laptop keys (backup controls)

| Key | Action |
| --- | --- |
| Enter | Start the game (setup) |
| Space | Roll · peek (hot-seat) · start the timer |
| Y / N | Got it / Failed (Brains: the quizmaster presses Correct / Wrong) |
| 1–6 | Pick a player (guesser, stealer, All Play winner) · 1–4 pick a category |
| 0 | Nobody |
| P | Peek again before the timer starts (hot-seat) |
| U | Undo the last result (before the next roll) |
| Esc | Back from a player pick |
| F / M / H | Fullscreen / mute / hot-seat toggle |
| D, number, Enter | Debug: jump the active token to that square |

## Deploy to GitHub Pages

Settings → Pages → Build and deployment → Source: **Deploy from a branch**, branch **main**, folder **/ (root)** → Save. The site appears at `https://<user>.github.io/spielchen/` within a minute or two.

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening the file directly with `file://` won't work, because ES modules need a server.

## Tests

```bash
node tests/rules.test.mjs
```

These cover the rules, the deck checks, commentary, and deck generation against a mocked model.

## Files

- `index.html`, `js/host.js`: the TV (state machine and rendering)
- `phone.html`, `js/phone.js`: the controller
- `js/rules.js`: board, movement and scoring (pure functions)
- `js/net.js`: PeerJS host and client, with reconnects
- `js/deck.js`, `js/generate.js`, `js/llm.js`: card schema, fresh-deck generation, API call
- `js/fx.js`, `js/icons.js`, `js/sfx.js`, `js/commentary.js`: motion, icons, sound, commentary
- `data/backup-deck.json`: 96 hand-written fallback cards
