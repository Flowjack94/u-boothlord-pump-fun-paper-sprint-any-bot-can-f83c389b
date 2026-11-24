// Flowjack94 pump.fun paper sprint bot — an early-entry spike rider written from scratch.
//
// What the dev-window data showed (and what this bot does about it):
// - Most pump.fun coins bleed after launch but spike hard in short bursts; the
//   spike is usually over by the time a "confirmed" momentum signal fires, so
//   chasing confirmed moves loses money after the 2-slot fill latency.
// - Buying early — as soon as the size cap allows a meaningful position —
//   catches the spike from below. So this bot enters on the first trade batch
//   where the cap reaches 0.02 SOL, with a small fixed 0.10 SOL stake.
// - Spikes dump before a +30% take-profit is reached, so the bot banks 80% of
//   the position at +15% and lets the rest ride to +30% / -20%.
// - In calm stretches positions would sit for hours and block the 5 slots, so a
//   slot-based stale timeout (40,000 slots) forces turnover; that is what clears
//   the 20-coin round-trip bar even in a quiet 6-hour window.
// - A global equity circuit breaker halts new entries at 30% drawdown and
//   liquidates at 40%, far from the 50% disqualifier.
//
// Fully deterministic: no clock, no randomness, no network. Every decision is a
// pure function of the batches the harness has delivered, in delivery order.

import { LAMPORTS_PER_SOL, type Batch, type Bot, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  /** SOL to spend per entry (before the per-mint size cap clips it). */
  stakeLamports: bigint;
  /** Smallest size cap (lamports) at which an entry is worth taking. */
  minCapLamports: bigint;
  /** Trades a coin needs before it can trigger an entry. */
  minTrades: number;
  /** Entry: price must be this far above the low of the recent window. */
  entryRise: number;
  /** Entry: share of the last 10 trades that must be buys. */
  minBuyShare: number;
  /** How many recent trade prices form the entry window. */
  windowTrades: number;
  /** Take profit, as a multiple of the entry price. */
  takeProfit: number;
  /** Stop loss, as a multiple of the entry price. */
  stopLoss: number;
  /** Trailing exit: sell when price falls this far below its peak, once the peak
   *  is at least `trailArm` above the entry price. */
  trailDrop: number;
  trailArm: number;
  /** Give up on a position after this many trades on its coin with no exit. */
  staleTrades: number;
  /** Give up on a position after this many slots with no exit (0 disables).
   *  Slots are the only clock the harness gives; a slot timeout is what frees
   *  slots in calm stretches where a coin barely trades. */
  staleSlots: number;
  /** Re-entering a coin we already exited needs a price above the exit price. */
  reentryMarkup: number;
  /** Bank a fraction of the position when price first reaches this multiple of
   *  the entry price (0 disables). The rest keeps riding to take-profit or
   *  stop-loss. Spikes that dump before take-profit still bank something. */
  partialAt: number;
  /** Fraction of tokens sold at the partial exit (0..1). */
  partialFrac: number;
  /** Stop opening new positions once equity drawdown from peak reaches this. */
  haltDrawdown: number;
  /** Liquidate everything once equity drawdown from peak reaches this. */
  panicDrawdown: number;
  /** Slippage tolerance on buys, in bps. Tight buys refuse to chase a vertical
   *  spike: if the fill is much worse than the decision price, skip it. */
  buySlippageBps: number;
  /** Slippage tolerance on sells, in bps. Wide sells make sure an exit actually
   *  executes during a dump instead of being refused and retried lower. */
  sellSlippageBps: number;
  /** When true, a coin that was exited is never entered again. */
  oneEntryPerCoin: boolean;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: LAMPORTS_PER_SOL / 10n, // 0.10 SOL per coin
  minCapLamports: (LAMPORTS_PER_SOL * 2n) / 100n, // 0.02 SOL
  // Early entry: enter on the first batch where the size cap allows a real
  // position. entryRise 1.0 and minBuyShare 0 disable the momentum filters —
  // the dev data showed chasing confirmed moves loses to fill latency.
  minTrades: 1,
  entryRise: 1.0,
  minBuyShare: 0,
  windowTrades: 12,
  takeProfit: 1.3,
  stopLoss: 0.8,
  trailDrop: 0.9,
  trailArm: 99, // trailing exit disabled; the partial take-profit does that job
  staleTrades: 100000, // effectively off; the slot timeout governs turnover
  staleSlots: 40000,
  reentryMarkup: 1.03,
  haltDrawdown: 0.3,
  panicDrawdown: 0.4,
  partialAt: 1.15,
  partialFrac: 0.8,
  // Tight buys refuse to chase a vertical spike; wide sells make sure an exit
  // actually executes during a dump instead of being refused and retried lower.
  buySlippageBps: 300,
  sellSlippageBps: 10000,
  oneEntryPerCoin: true,
};

interface Coin {
  /** Recent post-trade prices, oldest first, capped at windowTrades. */
  prices: number[];
  /** Buy flag per price in `prices`. */
  buys: boolean[];
  /** Total TradeEvents seen on this coin. */
  trades: number;
  /** Price when our current position filled (null when flat). */
  entryPrice: number | null;
  /** Highest price seen since the current entry. */
  peakPrice: number;
  /** Trade count on this coin when the current position filled. */
  entryTrades: number;
  /** Slot when the current position filled. */
  entrySlot: number;
  /** Whether the partial profit-take already fired for the current position. */
  partialTaken: boolean;
  /** Price when we last exited this coin (null when never exited). */
  lastExitPrice: number | null;
}

function curvePrice(state: BotState, mint: string): number | null {
  const c = state.curves.get(mint);
  if (c === undefined || c.complete) return null;
  if (c.virtual_token_reserves <= 0n || c.virtual_quote_reserves <= 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

/**
 * How many of `tokens` can actually be sold now: the bonding curve only pays
 * out of its real SOL reserve, so a sell whose quote-out exceeds that reserve
 * is rejected (max_order_size). Solve quoteOut(t) = t*vq/(vt+t) <= 85% of the
 * real reserve for t. Returns 0 when the pool is too drained to pay anything
 * meaningful — then the position is left for the harness to flatten/write off
 * instead of spamming a sell that can never fill.
 */
function sellableTokens(state: BotState, mint: string, tokens: bigint): bigint {
  const c = state.curves.get(mint);
  if (c === undefined || c.complete) return 0n;
  if (c.virtual_token_reserves <= 0n || c.virtual_quote_reserves <= 0n) return 0n;
  const limit = (c.real_quote_reserves * 85n) / 100n;
  if (limit <= 0n) return 0n;
  if (c.virtual_quote_reserves <= limit) return tokens;
  const fit = (limit * c.virtual_token_reserves) / (c.virtual_quote_reserves - limit);
  const qty = fit < tokens ? fit : tokens;
  // Selling must clear its own tx fee by a margin, or it is not worth sending.
  const quoteOut = (qty * c.virtual_quote_reserves) / (c.virtual_token_reserves + qty);
  const proceeds = (quoteOut * 9875n) / 10000n - state.txFeeLamports();
  if (proceeds <= 0n) return 0n;
  return qty;
}

/** Mark-to-market equity in lamports: cash + positions at current curve prices,
 *  net of the ~1.25% curve fees and one tx fee per position. */
function equityLamports(state: BotState): number {
  const tx = Number(state.txFeeLamports());
  let equity = Number(state.cash);
  for (const [mint, pos] of state.positions) {
    const p = curvePrice(state, mint);
    if (p === null) continue;
    const value = Number(pos.token_amount) * p * 0.9875 - tx;
    if (value > 0) equity += value;
  }
  return equity;
}

export function createStrategy(params: Params): Bot {
  const coins = new Map<string, Coin>();
  /** Mints with a partial sell in flight: skip exit decisions until it settles,
   *  so a full sell never overstates the tokens still held. */
  const partialPending = new Set<string>();
  let peakEquity = Number(LAMPORTS_PER_SOL) * 10; // 10 SOL starting capital
  let halted = false;

  const coinFor = (mint: string): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { prices: [], buys: [], trades: 0, entryPrice: null, peakPrice: 0, entryTrades: 0, entrySlot: 0, partialTaken: false, lastExitPrice: null };
      coins.set(mint, c);
    }
    return c;
  };

  return {
    onBatch(state, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const tx = state.txFeeLamports();

      // --- 1. Fold this batch's trades into per-coin history. ---
      for (const e of batch.events) {
        if (e.event !== 'TradeEvent') continue;
        const c = coinFor(e.mint);
        const vt = BigInt(e.virtual_token_reserves);
        const vq = BigInt(e.virtual_quote_reserves);
        if (vt <= 0n || vq <= 0n) continue;
        c.prices.push(Number(vq) / Number(vt));
        c.buys.push(e.is_buy);
        if (c.prices.length > params.windowTrades) {
          c.prices.shift();
          c.buys.shift();
        }
        c.trades += 1;
      }

      // --- 2. Settle fills: entries anchor at the fill-time price, exits remember it. ---
      for (const f of batch.fills) {
        if (f.side === 'sell') partialPending.delete(f.mint);
        if (f.status !== 'filled') continue;
        const c = coins.get(f.mint);
        if (c === undefined) continue;
        const p = curvePrice(state, f.mint);
        if (f.side === 'buy') {
          if (p !== null) {
            c.entryPrice = p;
            c.peakPrice = p;
            c.entryTrades = c.trades;
            c.entrySlot = batch.slot;
            c.partialTaken = false;
          }
        } else if (f.side === 'sell') {
          // A partial sell leaves tokens held: keep the entry anchored so the
          // remainder still exits on take-profit / stop-loss. Only a full close
          // (no position left) records the exit price and clears the entry.
          if (!state.positions.has(f.mint)) {
            if (p !== null) c.lastExitPrice = p;
            c.entryPrice = null;
            c.peakPrice = 0;
            c.partialTaken = false;
          }
        }
      }

      // --- 3. Equity circuit breaker. ---
      const equity = equityLamports(state);
      if (equity > peakEquity) peakEquity = equity;
      const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
      halted = drawdown >= params.haltDrawdown;

      // --- 4. Exits first: free slots before considering entries. ---
      const pendingSell = new Set<string>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell') pendingSell.add(p.order.mint);
      }
      const panic = drawdown >= params.panicDrawdown;
      for (const [mint, pos] of state.positions) {
        if (pendingSell.has(mint)) continue;
        if (partialPending.has(mint)) continue;
        const c = coins.get(mint);
        const p = curvePrice(state, mint);
        if (p === null || c === null || c === undefined) continue;
        if (c.entryPrice === null) continue; // entry fill not seen yet; hold
        if (p > c.peakPrice) c.peakPrice = p;
        const entry = c.entryPrice;
        const sell =
          panic ||
          p >= entry * params.takeProfit ||
          p <= entry * params.stopLoss ||
          (c.peakPrice >= entry * params.trailArm && p <= c.peakPrice * params.trailDrop) ||
          c.trades - c.entryTrades >= params.staleTrades ||
          (params.staleSlots > 0 && batch.slot - c.entrySlot >= params.staleSlots);
        if (sell) {
          const qty = sellableTokens(state, mint, pos.token_amount);
          if (qty > 0n) {
            orders.push({ side: 'sell', mint, token_amount: qty, max_slippage_bps: params.sellSlippageBps });
            pendingSell.add(mint);
          }
        } else if (
          params.partialAt > 0 &&
          !c.partialTaken &&
          p >= entry * params.partialAt
        ) {
          // Bank part of the spike; the rest rides to take-profit / stop-loss.
          const want = (pos.token_amount * BigInt(Math.round(params.partialFrac * 1000))) / 1000n;
          const qty = sellableTokens(state, mint, want);
          if (qty > 0n && qty < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: qty, max_slippage_bps: params.sellSlippageBps });
            c.partialTaken = true;
            partialPending.add(mint);
          }
        }
      }

      // --- 5. Entries: confirmed burst + buy pressure, small fixed stake. ---
      if (!halted) {
        const caps = state.hello.caps;
        let free = state.freeCashLamports();
        let slots = caps.max_open_positions - state.committedPositionCount();
        const pendingBuy = new Set<string>();
        for (const p of state.pending.values()) {
          if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
        }
        const seenThisBatch = new Set<string>();
        for (const e of batch.events) {
          if (orders.length >= caps.max_orders_per_batch) break;
          if (slots <= 0) break;
          const mint = e.mint;
          if (seenThisBatch.has(mint)) continue;
          seenThisBatch.add(mint);
          if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const c = coins.get(mint);
          if (c === undefined || c.trades < params.minTrades) continue;
          if (c.prices.length < params.minTrades) continue;
          const last = c.prices[c.prices.length - 1]!;
          let low = last;
          for (const p of c.prices) if (p < low) low = p;
          if (last < low * params.entryRise) continue;
          const recent = c.buys.slice(-10);
          let buyCount = 0;
          for (const b of recent) if (b) buyCount += 1;
          if (recent.length === 0 || buyCount / recent.length < params.minBuyShare) continue;
          if (params.oneEntryPerCoin && c.lastExitPrice !== null) continue;
          if (c.lastExitPrice !== null && last < c.lastExitPrice * params.reentryMarkup) continue;
          const cap = state.maxBuyLamports(mint);
          if (cap < params.minCapLamports) continue;
          const amount = cap < params.stakeLamports ? cap : params.stakeLamports;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: params.buySlippageBps });
          free -= amount + tx;
          slots -= 1;
          pendingBuy.add(mint);
        }
      }

      return orders;
    },
  };
}
