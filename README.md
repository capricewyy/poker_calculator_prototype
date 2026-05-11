# Poker Night

A tool for tracking the money side of a recurring home poker game: who bought
in, who paid for dinner, who walked away with which stack of chips, and who
owes whom at the end of the night. Over time, it becomes a record of how each
player has done across a season and a lifetime within their group.

## Status

This repository currently contains a **working prototype**, not the product.

The prototype is a small static web app that runs entirely in a browser and
tracks **one session at a time** via `localStorage`. It is in real use
during home games and handles the messy real-world cases — chip miscounts,
mixed chip/money buy-ins, custom dinner splits, couples settling as one
unit — and produces a minimal list of transfers in seconds.

What it does *not* do yet: persistent multi-session history, groups, seasons,
multi-device sync, or any kind of account model. Those are the next chapter
and are described in the spec below.

## Try the prototype

The deployable app lives under [`app/`](app/). Open
[app/index.html](app/index.html) directly in a browser, or run a local
static server:

```sh
cd app
npx http-server . -p 8080
# then open http://127.0.0.1:8080/
```

No build step, no install, no backend.

An earlier version is kept for reference at
[legacy/poker-calculator-v1.html](legacy/poker-calculator-v1.html). It is
not deployed.

Data is stored in `localStorage` for the origin you opened the app from.
Clearing browser data will erase it.

### Running the tests

Integration tests use Playwright and live under [`app/tests/integration/`](app/tests/integration/).

```sh
cd app
npm install
npx playwright install chromium
npm test
```

## Documentation

The repository is organized around two layers of docs.

**Product spec** — the *what* and *why*. Start here to understand the
product's intent.

- [docs/spec/overview.md](docs/spec/overview.md) — product objective, target
  users, principles, scope
- [docs/spec/features.md](docs/spec/features.md) — feature catalog with
  implementation status and open product questions

**Technical design** — the *how*, scoped to the current prototype.

- [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) — current code structure, data
  model, algorithms, and the seams along which the prototype would evolve
  into a real app

## Repository layout

```text
.
├── README.md                       — this file
├── TECHNICAL_DESIGN.md             — prototype-level technical reference
├── app/                            — prototype v2 (current, deployable)
│   ├── index.html
│   ├── styles.css
│   ├── src/                        — ES modules (state, calc, ui, main)
│   ├── tests/integration/          — Playwright specs
│   ├── package.json
│   └── playwright.config.js
├── legacy/
│   └── poker-calculator-v1.html    — prototype v1 (reference only, not deployed)
└── docs/
    ├── refactor-2026-05-11.md      — refactor design notes
    └── spec/                       — product spec (vision + features)
```

## License

See [LICENSE](LICENSE).
