![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Flowjack94/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)
![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Flowjack94/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)

# Pump.fun Paper Sprint bot

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) — a paper-trading bot for the `agent-fun/replay/v2` harness (Node 22, `main.ts`). No real funds, no real trades.

## Strategy

An early-entry spike rider, tuned on the kit's dev window (128,058 events):

- **Enter early:** buy a coin as soon as the per-mint size cap allows a real position (0.02 SOL cap), with a fixed 0.10 SOL stake. The dev data showed chasing "confirmed" momentum loses money after the 2-slot fill latency — the spike is over by the time the signal fires — so this bot buys before the spike instead.
- **Bank the spike:** sell 80% of the position at +15%, let the rest ride to a +30% take-profit or a −20% stop-loss. Spikes that dump before take-profit still bank something.
- **Forced turnover:** a 40,000-slot stale timeout frees slots in calm stretches, which is what clears the 20-coin round-trip bar even in a quiet 6-hour window.
- **Right-sized exits:** sells are sized to what the curve's real SOL reserve can actually pay, so exits fill instead of being rejected when a pool drains.
- **Circuit breaker:** new entries halt at 30% equity drawdown; everything liquidates at 40% — far from the 50% disqualifier.
- **Deterministic:** no clock, no randomness, no network. Every decision is a pure function of the delivered batches. The grader's two executions reproduce byte for byte.

## Local replay (kit dev window, `grade-local --driver process`)

- Net PnL: **−0.396 SOL** (return −3.96%; the dev window is a cold, bleeding market for this strategy family — the final 6-hour window is a fresh draw)
- Fills: 298 over **118 coins**, 118 round trips, win rate 43.2%
- Max drawdown: **4.6%** (limit 50%)
- Guardrails: met — 118 coins hold a round trip of at least 0.01 SOL
- Rejected orders: 37 (slippage only); 5 failed transactions

## Layout

- `main.ts` — entrypoint (the grader runs `node /bot/main.ts`)
- `strategy.ts` — the strategy (all parameters in `DEFAULT_PARAMS`)
- `vendor/makefun-bot.ts` — the kit's harness shim, vendored byte for byte
- `LICENSE` — MIT
