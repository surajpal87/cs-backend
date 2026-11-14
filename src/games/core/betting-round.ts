import { assert, intArg, PlayerAction, SeatedPlayer } from './engine';

/**
 * Helpers for house-banked round games (Andar Bahar, Baccarat): every seated player places
 * bets concurrently during a timed betting window, then the round resolves in one step.
 */
export interface Bettor {
  userId: string;
  seat: number;
  name: string;
  startStack: number;
  stack: number;
  bets: Record<string, number>;
  ready: boolean;
  payout: number;
}

export interface BetLimits {
  minBet: number;
  maxBet: number;
}

export function makeBettors(seated: SeatedPlayer[]): Bettor[] {
  return [...seated]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({ userId: p.userId, seat: p.seat, name: p.name, startStack: p.stack, stack: p.stack, bets: {}, ready: false, payout: 0 }));
}

export function placeBet(b: Bettor, action: PlayerAction, spots: readonly string[], limits: BetLimits) {
  assert(!b.ready, 'Your bets are locked for this round');
  const spot = action.spot;
  assert(typeof spot === 'string' && spots.includes(spot), `Bet spot must be one of ${spots.join(', ')}`, 'BAD_ARGUMENT');
  const amount = intArg(action, 'amount');
  assert(amount >= limits.minBet, `Minimum bet is ${limits.minBet}`, 'MIN_BET');
  const newTotal = (b.bets[spot] ?? 0) + amount;
  assert(newTotal <= limits.maxBet, `Maximum bet per spot is ${limits.maxBet}`, 'MAX_BET');
  assert(b.stack >= amount, 'Not enough chips', 'INSUFFICIENT_CHIPS');
  b.stack -= amount;
  b.bets[spot] = newTotal;
}

export function clearBets(b: Bettor) {
  assert(!b.ready, 'Your bets are locked for this round');
  for (const v of Object.values(b.bets)) b.stack += v;
  b.bets = {};
}

export function totalBet(b: Bettor): number {
  return Object.values(b.bets).reduce((a, c) => a + c, 0);
}
