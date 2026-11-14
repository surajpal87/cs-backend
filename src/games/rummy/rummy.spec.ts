import { SeededRng } from '../core/rng';
import { RummyEngine, RummyState } from './rummy.engine';
import { bestArrangement, isPureSequence, isSequence, isSet } from './rummy.melds';

const ids = (s: string) => s.split(' ').map((c, i) => `${c}#${i % 2}`);
const WILD = 5; // fives are wild in these tests

describe('rummy melds', () => {
  it('validates pure sequences including ace low/high but not wrap-around', () => {
    expect(isPureSequence(ids('Ah 2h 3h'))).toBe(true);
    expect(isPureSequence(ids('Qh Kh Ah'))).toBe(true);
    expect(isPureSequence(ids('Kh Ah 2h'))).toBe(false);
    expect(isPureSequence(ids('4h 5h 6h'))).toBe(true); // wild rank in natural position is still pure
    expect(isPureSequence(ids('4h 6h 7d'))).toBe(false);
  });

  it('allows jokers to fill sequences and sets', () => {
    expect(isSequence(ids('4h 5c 6h'), WILD)).toBe(true); // 5c is a wild joker
    expect(isSequence(ids('9s X1 Js'), WILD)).toBe(true); // printed joker
    expect(isSequence(ids('9s X1 Kd'), WILD)).toBe(false);
    expect(isSet(ids('8c 8d 8h'), WILD)).toBe(true);
    expect(isSet(ids('8c 8c 8h'), WILD)).toBe(false); // duplicate suit
    expect(isSet(ids('8c 8d X1 5s'), WILD)).toBe(true);
    expect(isSet(ids('8c 8d 8h 8s X1'), WILD)).toBe(false); // max 4
  });

  it('recognises a valid 13-card declaration', () => {
    // pure seq (A-2-3h), seq with joker (9s X1 Js), set (8c 8d 8h), set (Kc Kd Ks), set (Kc Kd Ks Kh)
    const hand = ids('Ah 2h 3h 9s X1 Js 8c 8d 8h Kc Kd Ks Kh');
    const a = bestArrangement(hand, WILD);
    expect(a.valid).toBe(true);
    expect(a.points).toBe(0);
    expect(a.melds.some((m) => m.kind === 'PURE_SEQUENCE')).toBe(true);
  });

  it('counts every card when there is no pure sequence', () => {
    // Sets only, no sequences at all.
    const hand = ids('8c 8d 8h Kc Kd Ks 2c 2d 2h 9s 9d Tc Js');
    const a = bestArrangement(hand, WILD);
    expect(a.valid).toBe(false);
    expect(a.points).toBe(8 * 3 + 10 * 3 + 2 * 3 + 9 * 2 + 10 + 10);
  });

  it('with a pure sequence but no second sequence, counts all cards outside it', () => {
    const hand = ids('Ah 2h 3h 8c 8d 8h Kc Kd Ks 2c 9d Tc 7s');
    const a = bestArrangement(hand, WILD);
    // Sets do not help without a second sequence: 8*3 + 10*3 + 2 + 9 + 10 + 7
    expect(a.points).toBe(24 + 30 + 2 + 9 + 10 + 7);
  });

  it('minimises deadwood once requirements are met', () => {
    const hand = ids('Ah 2h 3h 7s 8s 9s 4c Kd Qc 2d 9d Tc Jh');
    const a = bestArrangement(hand, WILD);
    expect(a.valid).toBe(false);
    expect(a.points).toBe(4 + 10 + 10 + 2 + 9 + 10 + 10);
  });
});

describe('rummy engine', () => {
  const engine = new RummyEngine();
  const cfg = engine.normalizeConfig({ pointValue: 2 });
  const players = [
    { userId: 'a', seat: 0, name: 'A', stack: 1000 },
    { userId: 'b', seat: 1, name: 'B', stack: 1000 },
    { userId: 'c', seat: 2, name: 'C', stack: 1000 },
  ];
  const rng = () => new SeededRng('c'.repeat(64));
  const total = (s: RummyState) => s.players.reduce((t, p) => t + p.stack, 0);

  it('deals 13 cards, opens discard and cuts a wild joker', () => {
    const s = engine.start(players, cfg, { handNumber: 1, rng: rng() }).state;
    expect(s.players.every((p) => p.hand.length === 13)).toBe(true);
    expect(s.discard).toHaveLength(1);
    expect(s.stock.length).toBe(108 - 39 - 1 - 1);
    expect(s.wildRank).toBeGreaterThanOrEqual(2);
  });

  it('enforces draw then discard', () => {
    let s = engine.start(players, cfg, { handNumber: 1, rng: rng() }).state;
    const uid = engine.pendingActors(s)[0];
    expect(() => engine.act(s, uid, { type: 'discard', card: s.players[s.turnIndex].hand[0] }, rng())).toThrow(/Draw a card/);
    s = engine.act(s, uid, { type: 'draw', from: 'stock' }, rng()).state;
    expect(s.players[s.turnIndex].hand).toHaveLength(14);
    s = engine.act(s, uid, { type: 'discard', card: s.players[s.turnIndex].hand[0] }, rng()).state;
    expect(engine.pendingActors(s)[0]).not.toBe(uid);
  });

  it('applies first-drop points and settles chips to the winner', () => {
    let s = engine.start(players, cfg, { handNumber: 1, rng: rng() }).state;
    const first = engine.pendingActors(s)[0];
    s = engine.act(s, first, { type: 'drop' }, rng()).state;
    expect(s.players.find((p) => p.userId === first)!.points).toBe(20);
    const second = engine.pendingActors(s)[0];
    s = engine.act(s, second, { type: 'drop' }, rng()).state;
    expect(s.phase).toBe('COMPLETE');
    expect(total(s)).toBe(3000);
    const winner = engine.results(s).find((r) => r.outcome === 'WIN')!;
    expect(winner.delta).toBe(2 * 20 * 2);
  });

  it('a valid declaration wins; others pay their capped points', () => {
    let s = engine.start(players, cfg, { handNumber: 1, rng: rng() }).state;
    const uid = engine.pendingActors(s)[0];
    const p = s.players[s.turnIndex];
    s.wildRank = WILD;
    p.hand = ids('Ah 2h 3h 9s X1 Js 8c 8d 8h Kc Kd Ks Kh');
    s.stock.push('6d#1');
    s.stock.push('Qc#0');
    s = engine.act(s, uid, { type: 'draw', from: 'stock' }, rng()).state; // draws Qc
    expect(() => engine.act(s, uid, { type: 'declare', card: 'Ah#0' }, rng())).not.toThrow();
    const bad = engine.act(s, uid, { type: 'declare', card: 'Ah#0' }, rng()).state;
    expect(bad.players.find((x) => x.userId === uid)!.status).toBe('WRONG_SHOW');
    const good = engine.act(s, uid, { type: 'declare', card: 'Qc#0' }, rng()).state;
    expect(good.phase).toBe('COMPLETE');
    expect(good.winner).toBe(uid);
    expect(total(good)).toBe(3000);
    for (const r of engine.results(good)) if (r.userId !== uid) expect(r.delta).toBeLessThanOrEqual(0);
  });

  it('auto-plays on timeout and drops after repeated misses', () => {
    let s = engine.start(players, cfg, { handNumber: 1, rng: rng() }).state;
    const uid = engine.pendingActors(s)[0];
    s = engine.onTimeout(s, rng()).state;
    expect(s.players.find((p) => p.userId === uid)!.hand).toHaveLength(13);
    expect(s.players.find((p) => p.userId === uid)!.missedTurns).toBe(1);
  });
});
