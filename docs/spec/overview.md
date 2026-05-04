# Poker Night — Product Overview

## What it is

Poker Night is a tool for tracking the money side of a recurring home poker
game: who bought in, who paid for dinner, who walked away with which stack of
chips, and who owes whom at the end of the night. Over many sessions, it
becomes a record of how each player has done across a season and a lifetime
within their group.

It is **not** a poker simulator, a hand tracker, a tournament manager, or a
payment processor. It is the spreadsheet that lives in the host's head, made
shared, persistent, and correct.

## Who it's for

Recurring home poker groups of roughly 3–12 friends or family.

Typical user:

- Plays with mostly the same crew weekly, monthly, or seasonally.
- Stakes are real but social — winning matters, but no one is doing this for
  a living.
- Side expenses (dinner, drinks, snacks) get bundled into the same end-of-night
  settlement.
- Couples and roommates often want to settle as a single unit, not per-person.
- Most participants will never sign up for an account just to play one night.
- The host is willing to do the bookkeeping; everyone else just wants to know
  what they owe.

## Why it exists

The current prototype already solves the **single-session** problem well: at
the end of the night, everybody knows who pays whom and the math is right. It
handles the messy real-world cases — chips don't add up, three people split a
pizza differently, a couple plays as one unit — and produces a minimal list of
transfers in seconds.

What it does **not** solve:

- *"How much have I won or lost this year?"* — no history beyond the current
  session.
- *"Who's the biggest winner this season?"* — no aggregation across sessions.
- *"My friend logged the night — can I just see the result?"* — single
  device, single browser.
- *"We have a Tuesday group and a separate weekend group."* — no concept of
  groups.
- *"I logged a buy-in wrong last month."* — no editable history.
- The tool is now specifically built for **cash games**, not for tournaments. Though we can mimic the outcome for tournaments via the cash game setup, it is unnatural and a dedicated mode should be developed for that.

The product's job is to take the working session-night experience and extend
it to **persistent history, multiple groups and seasons, and sharing across
devices**, without sacrificing the simplicity that makes the prototype usable
during a live game.

## Product principles

These are the trade-off rules. When a feature decision is unclear, lean on
these.

1. **Night-of usability is sacred.** Anything that slows down logging during a
   live game is a regression. The session flow must remain glance-and-tap simple
   even as the back-end grows.
2. **Account management is light.** Identity is preferably linked to an
   existing **social or email account** (Google, Instagram, etc.) so we never
   run our own password store and players use credentials they already have.
   When that isn't possible — a guest at the table who can't or won't link an
   account right now — the host can fall back to entering them by **name
   only**, and the player can claim the record via invite later. Both modes
   appear in history; the social/email path is the default, name-only is the
   backup.
3. **Money math is correct, always.** Chip miscounts, mixed chip/money entry,
   custom dinner splits, and family aggregation must settle to zero (or to the
   pot total) without manual fudging.
4. **History is permanent.** Once a session is settled, its records do not
   silently mutate. Edits are explicit; deletes are soft.
5. **Sharing is read-mostly.** The host logs the night; everyone else watches.
   Concurrent multi-editor flows are a non-goal for v1.
6. **Don't lose what works.** The chip-rate model, pot rebalancing, family-
   aware settlement, and the six-tab UX have been validated through real use.
   Carry them forward.

## Scope

### In scope

- **Persistent multi-session tracking** — every night played is its own record.
- **Groups** — recurring playing crews, each with their own member list.
- **Seasons** — a window within a group (e.g. Q1 2026), used as the natural
  bucket for leaderboards and P/L summaries.
- **Per-player P/L** — across a session, a season, and lifetime within a group.
- **Multi-device sync** — the host can log on phone or laptop and see the same
  data. Participants on their own devices can view results.
- **Read-only sharing** with non-host participants.
- **Mobile and web access** — both must work well.

### Out of scope (for now)

- **Live in-hand or per-pot tracking.** We track per-session totals only.
- **Tournament structures** (blinds, levels, payouts).
- **Real-money transfers.** The app says who owes whom; people pay each other
  via PayPal, or cash on their own. No payment processing.
- **Public or cross-group leaderboards.** Stats are scoped to a group.
- **AI / computer-vision chip recognition.** Cool, not the bottleneck.
- **Concurrent multi-host editing of the same session.** The host owns the log
  for that night.

### Explicitly deferred (likely yes, not yet)

- Generalizing "dinner" to arbitrary shared expenses (drinks, snacks, the Uber
  home). See open question in [features.md](features.md).
- Settlement-tracking ("Alice has paid Bob") rather than just suggested
  transfers.
- Push notifications and reminders.

## Success criteria

The product is successful when, twelve months in:

- A recurring group has logged ten or more sessions and can pull up "who's up
  the most this season" in a single tap.
- Hosts in that group are using the app on their phones during games, not the
  prototype HTML file.
- A non-host group member who installed the app can see their own P/L without
  asking the host for a screenshot.
