import { SeededRng } from '../core/rng';
import { OmahaEngine } from '../omaha/omaha.engine';
import { HoldemState } from './holdem-core';
import { PokerEngine } from './poker.engine';
import { evaluateFive, evaluateHoldem, evaluateOmaha } from './poker.hand';

const c = (s: string) => s.split(' ');
const seed = 'b'.repeat(64);

describe('poker hand evaluator', () => {
  it('orders all nine categories', () => {
    const hands = [
      '9h Th Jh Qh Kh', // straight flush
      '9c 9d 9h 9s 2c', // quads
      '9c 9d 9h 2s 2c', // full house
      '2h 7h 9h Jh Kh', // flush
      '5c 6d 7h 8s 9c', // straight
      '9c 9d 9h 2s 3c', // trips
      '9c 9d 2h 2s 3c', // two pair
      '9c 9d 2h 4s 3c', // pair
      'Ac 9d 2h 4s 3c', // high card
    ].map((h) => evaluateFive(c(h)));
    for (let i = 0; i < hands.length - 1; i++) expect(hands[i].score).toBeGreaterThan(hands[i + 1].score);
    expect(hands.map((h) => h.category)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('handles the wheel and kickers', () => {
    const wheel = evaluateFive(c('Ac 2d 3h 4s 5c'));
    const sixHigh = evaluateFive(c('2d 3h 4s 5c 6d'));
    expect(wheel.category).toBe(5);
    expect(sixHigh.score).toBeGreaterThan(wheel.score);
    expect(evaluateFive(c('Ac Ad Kh 4s 3c')).score).toBeGreaterThan(evaluateFive(c('Ac Ad Qh Js Tc')).score);
  });

  it("Hold'em picks the best five of seven", () => {
    const v = evaluateHoldem(c('Ah Kh'), c('Qh Jh Th 2c 3d'));
    expect(v.name).toBe('Straight Flush');
  });

  it('Omaha must use exactly two hole cards', () => {
    // Four hearts on board, only one heart in hand -> no flush in Omaha (would be in Hold'em).
    const hole = c('Ah 2c 7d 8s');
    const board = c('Kh Qh 9h 4h 3c');
    expect(evaluateHoldem(hole.slice(0, 2), board).name).toBe('Flush');
    expect(evaluateOmaha(hole, board).name).not.toBe('Flush');
    // Board quads cannot be used as four-of-a-kind in Omaha.
    expect(evaluateOmaha(c('2c 3d 5h 7s'), c('Ac Ad Ah As Kc')).name).toBe('Three of a Kind');
  });
});

describe("Texas Hold'em engine", () => {
  const engine = new PokerEngine();
  const cfg = engine.normalizeConfig({ smallBlind: 5, bigBlind: 10 });
  const total = (s: HoldemState) => s.players.reduce((t, p) => t + p.stack + (s.street === 'COMPLETE' ? 0 : p.contributed), 0);

  it('heads-up: dealer posts SB and acts first preflop, BB acts first after', () => {
    const r = engine.start(
      [
        { userId: 'a', seat: 0, name: 'A', stack: 500 },
        { userId: 'b', seat: 1, name: 'B', stack: 500 },
      ],
      cfg,
      { handNumber: 1, rng: new SeededRng(seed) },
    );
    let s = r.state;
    expect(s.players[0].contributed).toBe(5);
    expect(s.players[1].contributed).toBe(10);
    expect(engine.pendingActors(s)).toEqual(['a']);
    s = engine.act(s, 'a', { type: 'call' }).state;
    expect(engine.pendingActors(s)).toEqual(['b']); // BB option
    s = engine.act(s, 'b', { type: 'check' }).state;
    expect(s.street).toBe('FLOP');
    expect(s.board).toHaveLength(3);
    expect(engine.pendingActors(s)).toEqual(['b']);
    // check down
    while (s.street !== 'COMPLETE') s = engine.act(s, engine.pendingActors(s)[0], { type: 'check' }).state;
    expect(s.board).toHaveLength(5);
    expect(total(s)).toBe(1000);
    expect(s.showdown).toHaveLength(2);
  });

  it('enforces the minimum raise and re-opens action', () => {
    const r = engine.start(
      [
        { userId: 'a', seat: 0, name: 'A', stack: 500 },
        { userId: 'b', seat: 1, name: 'B', stack: 500 },
        { userId: 'c', seat: 2, name: 'C', stack: 500 },
      ],
      cfg,
      { handNumber: 1, rng: new SeededRng(seed) },
    );
    let s = r.state; // dealer a, sb b, bb c, a acts first
    expect(engine.pendingActors(s)).toEqual(['a']);
    expect(() => engine.act(s, 'a', { type: 'raise', amount: 15 })).toThrow(/Minimum raise/);
    s = engine.act(s, 'a', { type: 'raise', amount: 30 }).state;
    expect(s.minRaise).toBe(20);
    s = engine.act(s, 'b', { type: 'call' }).state;
    s = engine.act(s, 'c', { type: 'raise', amount: 70 }).state;
    expect(engine.pendingActors(s)).toEqual(['a']);
  });

  it('builds side pots correctly for multiple all-ins', () => {
    const r = engine.start(
      [
        { userId: 'a', seat: 0, name: 'A', stack: 100 },
        { userId: 'b', seat: 1, name: 'B', stack: 300 },
        { userId: 'c', seat: 2, name: 'C', stack: 600 },
      ],
      cfg,
      { handNumber: 1, rng: new SeededRng(seed) },
    );
    let s = r.state;
    // Rig: a has the best hand, b second, c worst.
    s.players[0].hole = c('Ah As');
    s.players[1].hole = c('Kh Ks');
    s.players[2].hole = c('2c 7d');
    // deck.pop() deals from the end: burn, flop x3, burn, turn, burn, river.
    const dealOrder = c('5d 3c 4c 9d 6h Jh Qc 8s');
    s.deck = [...dealOrder].reverse();
    s = engine.act(s, 'a', { type: 'allin' }).state;
    s = engine.act(s, 'b', { type: 'allin' }).state;
    s = engine.act(s, 'c', { type: 'call' }).state;
    expect(s.street).toBe('COMPLETE');
    expect(s.pots.map((p) => p.amount)).toEqual([300, 400]);
    expect(s.pots[0].eligible.sort()).toEqual(['a', 'b', 'c']);
    expect(s.pots[1].eligible.sort()).toEqual(['b', 'c']);
    expect(total(s)).toBe(1000);
    const stacks = engine.finalStacks(s);
    expect(stacks.a + stacks.b + stacks.c).toBe(1000);
  });

  it('folds to a single player without showdown', () => {
    const r = engine.start(
      [
        { userId: 'a', seat: 0, name: 'A', stack: 500 },
        { userId: 'b', seat: 1, name: 'B', stack: 500 },
      ],
      cfg,
      { handNumber: 2, rng: new SeededRng(seed) },
    );
    const s = engine.act(r.state, engine.pendingActors(r.state)[0], { type: 'fold' }).state;
    expect(s.street).toBe('COMPLETE');
    expect(s.showdown).toHaveLength(0);
    expect(engine.results(s).reduce((t, x) => t + x.delta, 0)).toBe(0);
  });
});

describe('Pot-Limit Omaha engine', () => {
  const engine = new OmahaEngine();
  it('deals four hole cards and caps raises at the pot', () => {
    const cfg = engine.normalizeConfig({ smallBlind: 5, bigBlind: 10 });
    const r = engine.start(
      [
        { userId: 'a', seat: 0, name: 'A', stack: 1000 },
        { userId: 'b', seat: 1, name: 'B', stack: 1000 },
        { userId: 'c', seat: 2, name: 'C', stack: 1000 },
      ],
      cfg,
      { handNumber: 1, rng: new SeededRng(seed) },
    );
    expect(r.state.players.every((p) => p.hole.length === 4)).toBe(true);
    // pot 15, a to call 10 -> pot after call 25 -> max raise to 10 + 25 = 35
    const raise = engine.legalActions(r.state, 'a').find((x) => x.type === 'raise')!;
    expect(raise.max).toBe(35);
    expect(() => engine.act(r.state, 'a', { type: 'raise', amount: 40 })).toThrow(/pot limit/);
    expect(engine.legalActions(r.state, 'a').some((x) => x.type === 'allin')).toBe(false);
  });
});
