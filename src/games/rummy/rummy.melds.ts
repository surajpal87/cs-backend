/**
 * 13-card (Indian) Rummy meld logic.
 *
 * Card ids are "<base>#<deck>" (e.g. "Ah#0", "X1#1") so duplicate cards from the two decks
 * stay distinct. Jokers are printed jokers ("X?") plus every card whose rank equals the
 * wild-joker rank cut at the start of the hand.
 */
import { rankOf, suitOf } from '../core/cards';

export type MeldKind = 'PURE_SEQUENCE' | 'SEQUENCE' | 'SET';

export function baseOf(id: string): string {
  return id.split('#')[0];
}

export function isJoker(id: string, wildRank: number): boolean {
  const b = baseOf(id);
  return b[0] === 'X' || rankOf(b) === wildRank;
}

export function cardPoints(id: string, wildRank: number): number {
  if (isJoker(id, wildRank)) return 0;
  const r = rankOf(baseOf(id));
  return r >= 10 ? 10 : r; // A, K, Q, J, 10 = 10
}

/** Ranks as consecutive run, ace low (1) or high (14). No jokers allowed. */
export function isPureSequence(ids: string[]): boolean {
  if (ids.length < 3) return false;
  const bases = ids.map(baseOf);
  if (bases.some((b) => b[0] === 'X')) return false;
  const suit = suitOf(bases[0]);
  if (!bases.every((b) => suitOf(b) === suit)) return false;
  const ranks = bases.map(rankOf);
  return consecutive(ranks) || consecutive(ranks.map((r) => (r === 14 ? 1 : r)));
}

function consecutive(ranks: number[]): boolean {
  const s = [...ranks].sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) if (s[i] !== s[i - 1] + 1) return false;
  return true;
}

/** Sequence where jokers may substitute for missing cards. */
export function isSequence(ids: string[], wildRank: number): boolean {
  if (ids.length < 3) return false;
  if (isPureSequence(ids)) return true;
  const natural = ids.filter((id) => !isJoker(id, wildRank)).map(baseOf);
  const jokers = ids.length - natural.length;
  if (natural.length === 0) return true; // all jokers
  const suit = suitOf(natural[0]);
  if (!natural.every((b) => suitOf(b) === suit)) return false;
  for (const aceLow of [false, true]) {
    const ranks = natural.map((b) => (aceLow && rankOf(b) === 14 ? 1 : rankOf(b))).sort((a, b) => a - b);
    if (new Set(ranks).size !== ranks.length) continue;
    const span = ranks[ranks.length - 1] - ranks[0] + 1;
    const gaps = span - ranks.length;
    if (gaps > jokers) continue;
    // Remaining jokers extend the run at either end; check the run fits within 1..14.
    const total = ids.length;
    const minStart = Math.max(aceLow ? 1 : 2, ranks[ranks.length - 1] - total + 1);
    const maxStart = Math.min(ranks[0], (aceLow ? 13 : 14) - total + 1);
    if (minStart <= maxStart) return true;
  }
  return false;
}

/** 3-4 cards of one rank in distinct suits; jokers may substitute. */
export function isSet(ids: string[], wildRank: number): boolean {
  if (ids.length < 3 || ids.length > 4) return false;
  const natural = ids.filter((id) => !isJoker(id, wildRank)).map(baseOf);
  if (natural.length === 0) return true;
  const r = rankOf(natural[0]);
  if (!natural.every((b) => rankOf(b) === r)) return false;
  const suits = natural.map(suitOf);
  return new Set(suits).size === suits.length;
}

export function classifyMeld(ids: string[], wildRank: number): MeldKind | null {
  if (isPureSequence(ids)) return 'PURE_SEQUENCE';
  if (isSequence(ids, wildRank)) return 'SEQUENCE';
  if (isSet(ids, wildRank)) return 'SET';
  return null;
}

export interface Arrangement {
  /** Points counted against the hand under the declaration rules (uncapped). */
  points: number;
  /** True when the hand is a valid declaration (0 points with the sequence requirements met). */
  valid: boolean;
  melds: { kind: MeldKind; cards: string[] }[];
  deadwood: string[];
}

// Achievement state: pure in {0,1} (capped), seq in {0,1,2} (capped). Encoded as pure*3+seq.
const ACH = 6;
function combine(a: number, kind: MeldKind): number {
  let pure = Math.floor(a / 3);
  let seq = a % 3;
  if (kind === 'PURE_SEQUENCE') {
    pure = 1;
    seq = Math.min(2, seq + 1);
  } else if (kind === 'SEQUENCE') seq = Math.min(2, seq + 1);
  return pure * 3 + seq;
}

/**
 * Finds the arrangement that minimises points for a hand, following standard rules:
 *  - a valid show needs >= 2 sequences, at least one pure; everything else in melds;
 *  - with the requirement met, only cards outside melds count;
 *  - with only a pure sequence, every card outside that pure sequence counts;
 *  - with no pure sequence, every card counts.
 */
export function bestArrangement(hand: string[], wildRank: number): Arrangement {
  const n = hand.length;
  if (n > 14) throw new Error('Hand too large');
  const full = (1 << n) - 1;
  const pts = hand.map((c) => cardPoints(c, wildRank));
  const total = pts.reduce((a, b) => a + b, 0);

  // Enumerate all valid melds once.
  const melds: { mask: number; kind: MeldKind; idx: number }[] = [];
  for (let m = 1; m <= full; m++) {
    const size = popcount(m);
    if (size < 3) continue;
    const cards = cardsOf(hand, m);
    const kind = classifyMeld(cards, wildRank);
    if (kind) melds.push({ mask: m, kind, idx: melds.length });
  }
  const byLowBit: { mask: number; kind: MeldKind; idx: number }[][] = Array.from({ length: n }, () => []);
  for (const m of melds) byLowBit[lowBit(m.mask)].push(m);

  const INF = 1e9;
  // dp[mask*ACH + a] = min deadwood points in `mask` given melds achieve state a exactly
  const dp = new Int32Array((full + 1) * ACH).fill(INF);
  const choice = new Int32Array((full + 1) * ACH).fill(-2); // -1 = lowest card is deadwood, >=0 meld index
  const prevA = new Int8Array((full + 1) * ACH);
  dp[0 * ACH + 0] = 0;
  for (let mask = 1; mask <= full; mask++) {
    const lb = lowBit(mask);
    const rest = mask & ~(1 << lb);
    for (let a = 0; a < ACH; a++) {
      const v = dp[rest * ACH + a];
      if (v >= INF) continue;
      const nv = v + pts[lb];
      if (nv < dp[mask * ACH + a]) {
        dp[mask * ACH + a] = nv;
        choice[mask * ACH + a] = -1;
        prevA[mask * ACH + a] = a;
      }
    }
    const list = byLowBit[lb];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if ((m.mask & mask) !== m.mask) continue;
      const r = mask & ~m.mask;
      for (let a = 0; a < ACH; a++) {
        const v = dp[r * ACH + a];
        if (v >= INF) continue;
        const na = combine(a, m.kind);
        if (v < dp[mask * ACH + na]) {
          dp[mask * ACH + na] = v;
          choice[mask * ACH + na] = m.idx;
          prevA[mask * ACH + na] = a;
        }
      }
    }
  }

  const reconstruct = (a: number): Arrangement => {
    const out: Arrangement = { points: 0, valid: false, melds: [], deadwood: [] };
    let mask = full;
    let st = a;
    while (mask) {
      const c = choice[mask * ACH + st];
      const pa = prevA[mask * ACH + st];
      if (c === -1) {
        const lb = lowBit(mask);
        out.deadwood.push(hand[lb]);
        mask &= ~(1 << lb);
      } else {
        out.melds.push({ kind: melds[c].kind, cards: cardsOf(hand, melds[c].mask) });
        mask &= ~melds[c].mask;
      }
      st = pa;
    }
    return out;
  };

  // Case A: requirements met (pure=1, seq=2 -> state 5).
  const best = dp[full * ACH + 5];
  let result: Arrangement | null = null;
  if (best < INF) {
    result = reconstruct(5);
    result.points = best;
    result.valid = best === 0;
  }
  // Case B: only a pure sequence counts in your favour.
  let bestPure: { kind: MeldKind; mask: number } | null = null;
  let bestPurePts = -1;
  for (const m of melds) {
    if (m.kind !== 'PURE_SEQUENCE') continue;
    let p = 0;
    for (let i = 0; i < n; i++) if (m.mask & (1 << i)) p += pts[i];
    if (p > bestPurePts) {
      bestPurePts = p;
      bestPure = m;
    }
  }
  if (bestPure && (!result || total - bestPurePts < result.points)) {
    result = {
      points: total - bestPurePts,
      valid: false,
      melds: [{ kind: 'PURE_SEQUENCE', cards: cardsOf(hand, bestPure.mask) }],
      deadwood: cardsOf(hand, full & ~bestPure.mask),
    };
  }
  if (!result || total < result.points) result = { points: total, valid: false, melds: [], deadwood: [...hand] };
  return result;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

function lowBit(x: number): number {
  return 31 - Math.clz32(x & -x);
}

function cardsOf(hand: string[], mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < hand.length; i++) if (mask & (1 << i)) out.push(hand[i]);
  return out;
}
