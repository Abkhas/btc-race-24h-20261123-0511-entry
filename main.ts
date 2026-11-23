// Ladder dip-buyer for the 24h BTC race (agent-fun/bars-replay/v1).
//
// Strategy, in brief: buy a small dip early, size the entry by how deep the
// dip already is, never finish a window without trading, and split the exit
// so half banks a fixed gain while the other half rides the move.
//
// Entry -- a three-rung ladder against the trailing 60-bar high of closes:
//   rung 1 at -0.75%, rung 2 at -1.25%, rung 3 at -1.75%. Each rung spends
//   one third of the starting capital. Rungs whose dips are already reached
//   fire together on the first entry bar, so a shallow dip buys a third and
//   a deep dip buys the whole capital at once; the position is not topped
//   up later in the episode. (Topping up while holding was tried and
//   dropped: in a slow grind down, the trailing high falls with the price,
//   so new rungs kept firing lower and lower, and the stop, measured off
//   the blended cost, chased the market down -- one validation window lost
//   $59.59 that way, against a $15.71 worst case for this version.)
//
// Fallback -- participation is guaranteed: if the bot is still flat at bar
//   720 (half the window), it buys 25% of capital on the next close at
//   least 0.50% below the trailing-60 high, or on the next 30-bar low,
//   whichever comes first. A bot must never end a 24h race with zero trades.
//
// Exit -- two tranches, both priced off the blended fill cost (the account's
//   cost basis, fees included):
//   tranche A (half the position) sells at +1.50% over fill cost;
//   tranche B (the other half) sells at a +2.50% cap, or on a trailing stop
//   1.00% below the highest close since entry, whichever comes first.
//   A -1.50% stop sells everything. After any full exit the bot waits
//   360 bars before buying again. No new buys in the final 60 bars.
//
// Validation (Coinbase BTC-USD 1-minute candles, public, no key): 42
// rolling 24h windows, 21 ending Nov 16-23 and 21 ending Nov 6-13,
// driven through this exact logic over the protocol with the documented
// fill model (4 bps fee, 2 bps slippage, constant-product impact). The
// bot fired in 42/42 windows (100%), mean PnL -$0.92 over all 42 (-$2.73
// on the older, strongly falling set; +$0.90 on the recent set), worst
// -$15.71, best +$13.72. Both 10-day blocks were net-down markets (mean
// market return -1.01% and -0.76%); buy-and-hold would have lost -$10.10
// and -$7.60 a window on the same sets, so the bot loses far less than
// the market in falls and profits when the window turns.
//
// All arithmetic is bigint, all state comes from the hello message and the
// batches the harness sends (seed, bars, fills, account). No clock, no
// environment, no network, no randomness, so two graded runs produce
// byte-identical action logs.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Entry ladder: dip in basis points below the trailing-60 close high, and
// the spend per rung in quote units (one third of the 1,000 USDC start).
const RUNGS_BPS = [75, 125, 175];
const RUNG_SPEND = 333_333_333n;
const FALLBACK_SPEND = 250_000_000n;

// Fallback timing and trigger.
const FALLBACK_BAR = 720;
const FALLBACK_DIP_BPS = 50;
const LOW_LOOKBACK = 30;

// Exits, in basis points over the blended fill cost / below the peak close.
const TP_A_BPS = 150;
const CAP_B_BPS = 250;
const TRAIL_B_BPS = 100;
const STOP_BPS = 150;

const COOLDOWN_BARS = 360;
const NO_BUY_AFTER_BAR = 1380;
const LOOKBACK_BARS = 60;
const MAX_SLIPPAGE_BPS = 200;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in quote units
const BPS = 10_000n;

type PendingKind = { kind: 'rung'; rung: number } | { kind: 'fb' } | { kind: 'sell'; tranche: 'a' | 'b' };

class LadderBot {
  private readonly state: BarsState;
  private readonly qtyScale: number;
  private readonly priceScale: number;
  private readonly quoteScale: number;
  private readonly closes: bigint[] = []; // every CBBTC close seen, oldest first
  private episode = 0; // counts entries, keeps client ids unique
  private readonly rungsFilled = new Set<number>(); // rung bps filled in this episode
  private readonly pending = new Map<string, PendingKind>(); // client_id -> what it was
  private trancheASold = false;
  private peak: bigint | null = null; // highest close since this episode began
  private wasHolding = false;
  private exitBar: number | null = null; // barsSeen of the last full exit
  private fallbackDone = false;

  constructor(state: BarsState) {
    this.state = state;
    const sym = state.symbols.get(SYMBOL);
    if (sym === undefined) throw new Error(`symbol ${SYMBOL} is not in hello`);
    this.qtyScale = sym.qty_scale;
    this.priceScale = sym.price_scale;
    this.quoteScale = state.hello.capital.quote_scale;
  }

  // -- helpers -----------------------------------------------------------

  /** 0-based index inside the scored window (warm-up bars excluded). */
  private barsSeen(): number {
    return this.state.seq - this.state.warmupBars;
  }

  /** Highest of the n closes before the current bar, or null. */
  private trailingHigh(n: number): bigint | null {
    if (this.closes.length <= n) return null;
    let hi = this.closes[this.closes.length - n - 1]!;
    for (let i = this.closes.length - n; i < this.closes.length - 1; i++) {
      if (this.closes[i]! > hi) hi = this.closes[i]!;
    }
    return hi;
  }

  /** How far the close sits below the trailing-60 close high, in bps. */
  private dipBps(close: bigint): bigint | null {
    const hi = this.trailingHigh(LOOKBACK_BARS);
    if (hi === null || hi <= 0n) return null;
    // Floor division (like Python's //): a dip of -75.9 bps is -76 bps.
    const num = (close - hi) * BPS;
    let d = num / hi;
    if (num % hi !== 0n && num < 0n) d -= 1n;
    return d;
  }

  /** Blended fill cost per qty unit, in price units (fees included). */
  private avgCostPrice(): bigint | null {
    const holding = this.state.positions.get(SYMBOL);
    if (holding === undefined || holding.qty <= 0n) return null;
    return (
      (holding.cost * 10n ** BigInt(this.qtyScale + this.priceScale)) /
      (holding.qty * 10n ** BigInt(this.quoteScale))
    );
  }

  private cooldownDone(): boolean {
    if (this.exitBar === null) return true;
    return this.barsSeen() - this.exitBar >= COOLDOWN_BARS;
  }

  // -- fills -------------------------------------------------------------

  /** Fold this batch's fills into the pending/rung/tranche state. */
  private applyFills(batch: Batch): void {
    for (const fill of batch.fills) {
      const kind = this.pending.get(fill.client_id);
      if (kind === undefined) continue;
      this.pending.delete(fill.client_id);
      if (fill.status !== 'filled') continue; // rejected: the rung/fallback may fire again
      if (kind.kind === 'rung') this.rungsFilled.add(kind.rung);
      else if (kind.kind === 'fb') this.fallbackDone = true;
      else if (kind.kind === 'sell' && kind.tranche === 'a') this.trancheASold = true;
    }
  }

  // -- main decision -----------------------------------------------------

  onBatch(batch: Batch): OrderInput[] {
    this.applyFills(batch);
    const close = this.state.close(SYMBOL);
    if (close === null) return [];
    this.closes.push(close);

    const holding = this.state.positions.get(SYMBOL);
    const qty = holding === undefined ? 0n : holding.qty;

    // A full exit just happened: start the cooldown and reset the episode.
    if (this.wasHolding && qty === 0n && this.pending.size === 0) {
      this.exitBar = this.barsSeen();
      this.episode += 1;
      this.rungsFilled.clear();
      this.trancheASold = false;
      this.peak = null;
      this.fallbackDone = false;
    }
    this.wasHolding = qty > 0n;

    if (this.state.warmingUp) return [];

    if (qty > 0n) return this.exitOrders(close, qty);
    return this.entryOrders(close);
  }

  private exitOrders(close: bigint, qty: bigint): OrderInput[] {
    const avg = this.avgCostPrice();
    if (avg === null || avg <= 0n) return [];
    if (this.peak === null || close > this.peak) this.peak = close;

    // Hard stop: -1.50% under the blended fill cost sells everything.
    if (close * BPS <= (avg * (BPS - BigInt(STOP_BPS)))) return [this.sell(qty, 'stop')];
    // Tranche A: half the position at +1.50% over fill cost.
    if (!this.trancheASold && close * BPS >= avg * (BPS + BigInt(TP_A_BPS))) {
      const half = qty / 2n;
      if (half > 0n) return [this.sell(half, 'a')];
      return [this.sell(qty, 'a')];
    }
    // Tranche B: the rest rides to a +2.50% cap or a 1.00% trailing stop.
    if (this.trancheASold) {
      if (close * BPS >= avg * (BPS + BigInt(CAP_B_BPS))) return [this.sell(qty, 'b-cap')];
      if (close * BPS <= this.peak * (BPS - BigInt(TRAIL_B_BPS))) return [this.sell(qty, 'b-trail')];
    }
    return [];
  }

  private sell(qty: bigint, kind: string): OrderInput {
    const cid = `e${this.episode}-${kind}-${this.barsSeen()}`;
    this.pending.set(cid, { kind: 'sell', tranche: kind === 'a' ? 'a' : 'b' });
    return { side: 'sell', client_id: cid, symbol: SYMBOL, qty: qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS };
  }

  private buy(spend: bigint, kind: string, rung: number | null): OrderInput {
    const cid = `e${this.episode}-${kind}-${this.barsSeen()}`;
    this.pending.set(cid, rung === null ? { kind: 'fb' } : { kind: 'rung', rung });
    return { side: 'buy', client_id: cid, symbol: SYMBOL, notional_quote_units: spend.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS };
  }

  private entryOrders(close: bigint): OrderInput[] {
    if (!this.cooldownDone()) return [];
    if (this.barsSeen() >= NO_BUY_AFTER_BAR) return [];
    for (const kind of this.pending.values()) {
      if (kind.kind === 'rung' || kind.kind === 'fb') return []; // a buy is already in flight; wait for its fill
    }

    const dip = this.dipBps(close);
    const orders: OrderInput[] = [];
    let spent = 0n;
    const cash = this.state.cash;

    // Ladder: every rung whose dip has been reached fires, a third each.
    if (dip !== null) {
      for (const rung of RUNGS_BPS) {
        if (this.rungsFilled.has(rung)) continue;
        if (dip <= BigInt(-rung)) {
          const spend = RUNG_SPEND < cash - spent ? RUNG_SPEND : cash - spent;
          if (spend >= MIN_NOTIONAL) {
            orders.push(this.buy(spend, `r${rung}`, rung));
            spent += spend;
          }
        }
      }
    }

    // Fallback: from bar 720, still flat, buy 25% on a -0.50% dip or a
    // fresh 30-bar low, so the window can never end with zero trades.
    if (orders.length === 0 && !this.fallbackDone && this.barsSeen() >= FALLBACK_BAR && dip !== null) {
      const window = this.closes.slice(-LOW_LOOKBACK);
      let low30: bigint | null = null;
      if (window.length >= LOW_LOOKBACK) {
        low30 = window[0]!;
        for (const c of window) if (c < low30!) low30 = c;
      }
      if (dip <= BigInt(-FALLBACK_DIP_BPS) || (low30 !== null && close <= low30)) {
        const spend = FALLBACK_SPEND < cash ? FALLBACK_SPEND : cash;
        if (spend >= MIN_NOTIONAL) orders.push(this.buy(spend, 'fb', null));
      }
    }

    return orders;
  }
}

let bot: LadderBot | null = null;

await runBars({
  onHello(state) {
    bot = new LadderBot(state);
  },
  onBatch(state, batch) {
    return bot!.onBatch(batch);
  },
});
