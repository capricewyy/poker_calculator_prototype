# Poker Night

A tool for tracking the money side of a recurring home poker game: who bought
in, who paid for dinner, who walked away with which stack of chips, and who
owes whom at the end of the night. Over time, it becomes a record of how each
player has done across a season and a lifetime within their group.

## Status

This repository currently contains a **working prototype**, not the product.

The prototype is a single self-contained HTML file that runs entirely in a
browser and tracks **one session at a time** via `localStorage`. It is in real
use during home games and handles the messy real-world cases — chip
miscounts, mixed chip/money buy-ins, custom dinner splits, couples settling
as one unit — and produces a minimal list of transfers in seconds.

What it does *not* do yet: persistent multi-session history, groups, seasons,
multi-device sync, or any kind of account model. Those are the next chapter
and are described in the spec below.

## Try the prototype

Open either file directly in a browser — no build step, no install, no
backend.

- [poker-calculator-v2.html](poker-calculator-v2.html) — current version
- [poker-calculator.html](poker-calculator.html) — earlier version, kept for
  reference

Data is stored in `localStorage` for the origin you opened the file from.
Clearing browser data will erase it.

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

```
.
├── README.md                   — this file
├── TECHNICAL_DESIGN.md         — prototype-level technical reference
├── poker-calculator.html       — prototype v1
├── poker-calculator-v2.html    — prototype v2 (current)
└── docs/
    └── spec/                   — product spec (vision + features)
```

## License

See [LICENSE](LICENSE).
