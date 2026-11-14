import { Rng } from './rng';

/**
 * Cards are compact strings: rank + suit, e.g. "Ah", "Td", "2c".
 * Jokers (Rummy only) are "X1", "X2", ... (printed jokers).
 */
export type Card = string;

export const SUITS = ['s', 'h', 'd', 'c'] as const;
export type Suit = (typeof SUITS)[number];
export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;

/** 2..14 (Ace high = 14). */
export function rankOf(card: Card): number {
  const ch = card[0];
  const idx = RANK_CHARS.indexOf(ch as (typeof RANK_CHARS)[number]);
  if (idx < 0) throw new Error(`Invalid card rank: ${card}`);
  return idx + 2;
}

export function suitOf(card: Card): Suit {
  return card[1] as Suit;
}

export function isPrintedJoker(card: Card): boolean {
  return card[0] === 'X';
}

export function rankChar(rank: number): string {
  return RANK_CHARS[rank - 2];
}

export function isValidCard(card: string): boolean {
  if (/^X\d$/.test(card)) return true;
  return card.length === 2 && RANK_CHARS.includes(card[0] as never) && SUITS.includes(card[1] as Suit);
}

/** Build one or more standard 52-card decks, optionally adding printed jokers. */
export function createDeck(decks = 1, jokers = 0): Card[] {
  const out: Card[] = [];
  for (let d = 0; d < decks; d++) {
    for (const s of SUITS) for (const r of RANK_CHARS) out.push(r + s);
  }
  for (let j = 1; j <= jokers; j++) out.push('X' + j);
  return out;
}

/** Unbiased Fisher-Yates shuffle driven by the injected RNG. Returns a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Baccarat-style point value: A=1, 2-9 face, T/J/Q/K = 0. */
export function baccaratValue(card: Card): number {
  const r = rankOf(card);
  if (r === 14) return 1;
  if (r >= 10) return 0;
  return r;
}
