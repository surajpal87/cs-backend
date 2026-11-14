import { Card, rankOf, suitOf } from '../core/cards';

export const POKER_CATEGORY_NAMES = [
  '',
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
] as const;

export interface PokerHandValue {
  /** Totally ordered score: higher is better. */
  score: number;
  category: number;
  name: string;
  cards: Card[];
}

function encode(category: number, kickers: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 15 + (kickers[i] ?? 0);
  return score;
}

/** Evaluates exactly five cards. */
export function evaluateFive(cards: Card[]): PokerHandValue {
  if (cards.length !== 5) throw new Error('evaluateFive needs 5 cards');
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const uniq = [...new Set(ranks)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5; // wheel A-2-3-4-5
  }
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Group by count desc, then rank desc.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const byGroup = groups.map((g) => g[0]);

  let category: number;
  let kickers: number[];
  if (straightHigh && flush) {
    category = 9;
    kickers = [straightHigh];
  } else if (groups[0][1] === 4) {
    category = 8;
    kickers = byGroup;
  } else if (groups[0][1] === 3 && groups[1][1] === 2) {
    category = 7;
    kickers = byGroup;
  } else if (flush) {
    category = 6;
    kickers = ranks;
  } else if (straightHigh) {
    category = 5;
    kickers = [straightHigh];
  } else if (groups[0][1] === 3) {
    category = 4;
    kickers = byGroup;
  } else if (groups[0][1] === 2 && groups[1][1] === 2) {
    category = 3;
    kickers = byGroup;
  } else if (groups[0][1] === 2) {
    category = 2;
    kickers = byGroup;
  } else {
    category = 1;
    kickers = ranks;
  }
  return { score: encode(category, kickers), category, name: POKER_CATEGORY_NAMES[category], cards: [...cards] };
}

function combinations<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i <= items.length - (k - acc.length); i++) {
      acc.push(items[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

function best(candidates: Card[][]): PokerHandValue {
  let top: PokerHandValue | null = null;
  for (const c of candidates) {
    const v = evaluateFive(c);
    if (!top || v.score > top.score) top = v;
  }
  return top!;
}

/** Texas Hold'em: best 5 of any of the 7 cards. */
export function evaluateHoldem(hole: Card[], board: Card[]): PokerHandValue {
  return best(combinations([...hole, ...board], 5));
}

/** Omaha: must use exactly two hole cards and exactly three board cards. */
export function evaluateOmaha(hole: Card[], board: Card[]): PokerHandValue {
  const cands: Card[][] = [];
  for (const h of combinations(hole, 2)) for (const b of combinations(board, 3)) cands.push([...h, ...b]);
  return best(cands);
}
