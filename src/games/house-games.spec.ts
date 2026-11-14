import { AndarBaharEngine } from './andar-bahar/andar-bahar.engine';
import { BaccaratEngine, handTotal, playCoup } from './baccarat/baccarat.engine';
import { rankOf } from './core/cards';
import { SeededRng } from './core/rng';
import { GoldMinesEngine, minesMultiplier } from './gold-mines/gold-mines.engine';

const rng = (ch = 'd') => new SeededRng(ch.repeat(64));
const two = [
  { userId: 'a', seat: 0, name: 'A', stack: 1000 },
  { userId: 'b', seat: 1, name: 'B', stack: 1000 },
];

describe('Andar Bahar', () => {
  const e = new AndarBaharEngine();
  const cfg = e.normalizeConfig({});

  it('deals until a card matches the joker rank and pays the right side', () => {
    let s = e.start(two, cfg, { handNumber: 1, rng: rng() }).state;
    s = e.act(s, 'a', { type: 'bet', spot: 'ANDAR', amount: 100 }).state;
    s = e.act(s, 'b', { type: 'bet', spot: 'BAHAR', amount: 100 }).state;
    s = e.act(s, 'a', { type: 'ready' }).state;
    s = e.act(s, 'b', { type: 'ready' }).state;
    expect(s.phase).toBe('COMPLETE');
    const winSide = s.winningSide!;
    const pile = winSide === 'ANDAR' ? s.andar : s.bahar;
    expect(rankOf(pile[pile.length - 1])).toBe(rankOf(s.joker!));
    // Only the last dealt card matches.
    for (const c of [...s.andar, ...s.bahar].slice(0, -1)) if (c !== pile[pile.length - 1]) expect(rankOf(c)).not.toBe(rankOf(s.joker!));
    const winner = winSide === 'ANDAR' ? 'a' : 'b';
    const expected = winSide === s.firstSide ? 90 : 100;
    expect(e.results(s).find((r) => r.userId === winner)!.delta).toBe(expected);
    expect(e.results(s).find((r) => r.userId !== winner)!.delta).toBe(-100);
  });

  it('validates bet limits and stacks', () => {
    const s = e.start(two, cfg, { handNumber: 1, rng: rng() }).state;
    expect(() => e.act(s, 'a', { type: 'bet', spot: 'ANDAR', amount: 5 })).toThrow(/Minimum/);
    expect(() => e.act(s, 'a', { type: 'bet', spot: 'MIDDLE', amount: 50 })).toThrow(/spot/);
    expect(() => e.act(s, 'a', { type: 'bet', spot: 'ANDAR', amount: 5001 })).toThrow();
  });

  it('closes betting on timeout and refunds nothing for non-bettors', () => {
    const s = e.start(two, cfg, { handNumber: 1, rng: rng() }).state;
    const done = e.onTimeout(s, rng()).state;
    expect(done.phase).toBe('COMPLETE');
    expect(e.results(done).every((r) => r.delta === 0)).toBe(true);
  });
});

describe('Baccarat', () => {
  const e = new BaccaratEngine();
  // playCoup pops from the end: P1, B1, P2, B2, [P3], [B3]
  const shoe = (order: string) => order.split(' ').reverse();

  it('stands on naturals', () => {
    const r = playCoup(shoe('9c Kd Th 2s 5c 5d'));
    expect(r.player).toEqual(['9c', 'Th']);
    expect(r.banker).toEqual(['Kd', '2s']);
  });

  it('player draws on 0-5, banker follows the tableau', () => {
    // Player 2+3=5 draws (gets 8). Banker 3 (Td 3s) must stand when player third card is 8.
    const r = playCoup(shoe('2c Td 3h 3s 8c 4d'));
    expect(r.player).toHaveLength(3);
    expect(r.banker).toHaveLength(2);
    // Banker 3 draws when player third card is not 8.
    const r2 = playCoup(shoe('2c Td 3h 3s 7c 4d'));
    expect(r2.banker).toHaveLength(3);
    // Banker 6 draws only on player third 6 or 7.
    expect(playCoup(shoe('Ac 2d 2h 4s 6c 9d')).banker).toHaveLength(3);
    expect(playCoup(shoe('Ac 2d 2h 4s 5c 9d')).banker).toHaveLength(2);
  });

  it('banker draws on 0-5 when player stands', () => {
    const r = playCoup(shoe('3c 2d 4h 2s 9c'));
    expect(r.player).toHaveLength(2); // 7 stands
    expect(r.banker).toHaveLength(3);
    expect(handTotal(['9c', '8d'])).toBe(7);
  });

  it('pays player 1:1, banker 0.95:1, tie 8:1 with pushes', () => {
    let s = e.start(two, e.normalizeConfig({}), { handNumber: 1, rng: rng() }).state;
    s.shoe = shoe('4c 4d 3h 3s Kc Kd'); // P 7 vs B 7 -> tie, P stands, B stands
    s = e.act(s, 'a', { type: 'bet', spot: 'TIE', amount: 10 }).state;
    s = e.act(s, 'b', { type: 'bet', spot: 'BANKER', amount: 100 }).state;
    s = e.act(s, 'a', { type: 'ready' }).state;
    s = e.act(s, 'b', { type: 'ready' }).state;
    expect(s.outcome).toBe('TIE');
    const res = Object.fromEntries(e.results(s).map((r) => [r.userId, r.delta]));
    expect(res).toEqual({ a: 80, b: 0 });

    let t = e.start(two, e.normalizeConfig({}), { handNumber: 2, rng: rng() }).state;
    t.shoe = shoe('2c 9d 3h Ks 2s');
    t = e.act(t, 'a', { type: 'bet', spot: 'BANKER', amount: 100 }).state;
    t = e.act(t, 'b', { type: 'bet', spot: 'PLAYER', amount: 100 }).state;
    t = e.onTimeout(t).state;
    expect(t.outcome).toBe('BANKER');
    const res2 = Object.fromEntries(e.results(t).map((r) => [r.userId, r.delta]));
    expect(res2).toEqual({ a: 95, b: -100 });
  });
});

describe('Gold Mines', () => {
  const e = new GoldMinesEngine();
  const cfg = e.normalizeConfig({});

  it('computes fair multipliers less the edge', () => {
    expect(minesMultiplier(25, 1, 1, 0)).toBeCloseTo(25 / 24, 2);
    expect(minesMultiplier(25, 3, 2, 0.03)).toBeCloseTo(Math.floor((25 / 22) * (24 / 21) * 0.97 * 100) / 100, 5);
    expect(minesMultiplier(25, 5, 0, 0.03)).toBe(1);
  });

  it('busts on a mine and pays on cash-out', () => {
    let s = e.start(two, cfg, { handNumber: 1, rng: rng() }).state;
    s = e.act(s, 'a', { type: 'start', amount: 100, mines: 3 }, rng('e')).state;
    s = e.act(s, 'b', { type: 'start', amount: 100, mines: 3 }, rng('f')).state;
    const aMines = s.miners[0].mines;
    const safe = [...Array(25).keys()].find((t) => !aMines.includes(t))!;
    s = e.act(s, 'a', { type: 'reveal', tile: safe }, rng()).state;
    expect((e.view(s, 'b') as { players: { mines: unknown }[] }).players[0].mines).toBeNull();
    s = e.act(s, 'a', { type: 'cashout' }, rng()).state;
    expect(s.miners[0].payout).toBe(Math.floor(100 * minesMultiplier(25, 3, 1, 0.03)));
    s = e.act(s, 'b', { type: 'reveal', tile: s.miners[1].mines[0] }, rng()).state;
    expect(s.miners[1].status).toBe('BUSTED');
    expect(s.phase).toBe('COMPLETE');
    expect(e.results(s).find((r) => r.userId === 'b')!.delta).toBe(-100);
  });

  it('refunds untouched stakes on timeout', () => {
    let s = e.start(two, cfg, { handNumber: 1, rng: rng() }).state;
    s = e.act(s, 'a', { type: 'start', amount: 100, mines: 3 }, rng()).state;
    s = e.onTimeout(s).state;
    expect(s.phase).toBe('COMPLETE');
    expect(e.results(s).every((r) => r.delta === 0)).toBe(true);
  });
});
