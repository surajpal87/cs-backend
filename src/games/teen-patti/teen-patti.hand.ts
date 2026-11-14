import { Card, rankOf, suitOf } from '../core/cards';

/** Teen Patti hand categories, highest first. */
export enum TpCategory {
  HIGH_CARD = 1,
  PAIR = 2,
  COLOR = 3,
  SEQUENCE = 4,
  PURE_SEQUENCE = 5,
  TRAIL = 6,
}

export const TP_CATEGORY_NAMES: Record<TpCategory, string> = {
  [TpCategory.HIGH_CARD]: 'High Card',
  [TpCategory.PAIR]: 'Pair',
  [TpCategory.COLOR]: 'Color',
  [TpCategory.SEQUENCE]: 'Sequence',
  [TpCategory.PURE_SEQUENCE]: 'Pure Sequence',
  [TpCategory.TRAIL]: 'Trail',
};

export interface TpHandValue {
  category: TpCategory;
  /** Tie-break values, compared lexicographically. */
  kickers: number[];
  name: string;
}

/**
 * Sequence strength: A-K-Q is the highest run, A-2-3 the second highest,
 * then K-Q-J down to 4-3-2.
 */
function sequenceKey(ranks: number[]): number | null {
  const [a, b, c] = ranks; // sorted desc
  if (a === 14 && b === 13 && c === 12) return 16;
  if (a === 14 && b === 3 && c === 2) return 15;
  if (a - b === 1 && b - c === 1) return a;
  return null;
}

export function evaluateTeenPatti(cards: Card[]): TpHandValue {
  if (cards.length !== 3) throw new Error('Teen Patti hands have exactly 3 cards');
  const ranks = cards.map(rankOf).sort((x, y) => y - x);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const seq = sequenceKey(ranks);

  let category: TpCategory;
  let kickers: number[];
  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) {
    category = TpCategory.TRAIL;
    kickers = [ranks[0]];
  } else if (seq !== null && flush) {
    category = TpCategory.PURE_SEQUENCE;
    kickers = [seq];
  } else if (seq !== null) {
    category = TpCategory.SEQUENCE;
    kickers = [seq];
  } else if (flush) {
    category = TpCategory.COLOR;
    kickers = ranks;
  } else if (ranks[0] === ranks[1] || ranks[1] === ranks[2]) {
    category = TpCategory.PAIR;
    const pair = ranks[1];
    const kicker = ranks[0] === ranks[1] ? ranks[2] : ranks[0];
    kickers = [pair, kicker];
  } else {
    category = TpCategory.HIGH_CARD;
    kickers = ranks;
  }
  return { category, kickers, name: TP_CATEGORY_NAMES[category] };
}

/** >0 if a beats b, <0 if b beats a, 0 for an exact tie. */
export function compareTeenPatti(a: TpHandValue, b: TpHandValue): number {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < Math.max(a.kickers.length, b.kickers.length); i++) {
    const d = (a.kickers[i] ?? 0) - (b.kickers[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
