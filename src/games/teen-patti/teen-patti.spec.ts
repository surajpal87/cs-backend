import { SeededRng } from '../core/rng';
import { TeenPattiEngine, TeenPattiState } from './teen-patti.engine';
import { compareTeenPatti, evaluateTeenPatti, TpCategory } from './teen-patti.hand';

const ev = (s: string) => evaluateTeenPatti(s.split(' '));
const seed = 'a'.repeat(64);

describe('Teen Patti hand ranking', () => {
  it('ranks categories trail > pure sequence > sequence > color > pair > high card', () => {
    const order = ['2c 2d 2h', 'Th Jh Qh', 'Th Jd Qh', '2h 7h Kh', '9c 9d Ah', 'As Kd 9h'];
    const cats = order.map((h) => ev(h).category);
    expect(cats).toEqual([
      TpCategory.TRAIL,
      TpCategory.PURE_SEQUENCE,
      TpCategory.SEQUENCE,
      TpCategory.COLOR,
      TpCategory.PAIR,
      TpCategory.HIGH_CARD,
    ]);
    for (let i = 0; i < order.length - 1; i++) expect(compareTeenPatti(ev(order[i]), ev(order[i + 1]))).toBeGreaterThan(0);
  });

  it('treats A-K-Q as the top run and A-2-3 as second', () => {
    expect(compareTeenPatti(ev('Ah Kd Qc'), ev('Ah 2d 3c'))).toBeGreaterThan(0);
    expect(compareTeenPatti(ev('Ah 2d 3c'), ev('Kh Qd Jc'))).toBeGreaterThan(0);
    expect(compareTeenPatti(ev('4h 3d 2c'), ev('Ah Kd 9c'))).toBeGreaterThan(0);
  });

  it('breaks pair ties on the kicker and detects exact ties', () => {
    expect(compareTeenPatti(ev('9c 9d Ah'), ev('9h 9s Kh'))).toBeGreaterThan(0);
    expect(compareTeenPatti(ev('Kc Td 5h'), ev('Kd Th 5c'))).toBe(0);
    expect(ev('Ac As Kd').kickers).toEqual([14, 13]);
  });
});

describe('Teen Patti engine', () => {
  const engine = new TeenPattiEngine();
  const config = engine.normalizeConfig({ boot: 10 });
  const players = [
    { userId: 'a', seat: 0, name: 'A', stack: 1000 },
    { userId: 'b', seat: 1, name: 'B', stack: 1000 },
    { userId: 'c', seat: 2, name: 'C', stack: 1000 },
  ];
  const fresh = () => engine.start(players, config, { handNumber: 1, rng: new SeededRng(seed) }).state;
  const rig = (s: TeenPattiState, hands: Record<string, string>) => {
    for (const p of s.players) p.cards = hands[p.userId].split(' ');
    return s;
  };
  const total = (s: TeenPattiState) => s.players.reduce((t, p) => t + p.stack, 0) + (s.phase === 'COMPLETE' ? 0 : s.pot);

  it('collects boot, deals 3 hidden cards and starts left of dealer', () => {
    const s = fresh();
    expect(s.pot).toBe(30);
    expect(s.players.every((p) => p.cards.length === 3 && p.stack === 990)).toBe(true);
    expect(s.players[s.turnIndex].userId).toBe('b');
    const v = engine.view(s, 'b') as { players: { cards: unknown }[] };
    expect(v.players.every((p) => p.cards === null)).toBe(true);
  });

  it('charges blind 1x and seen 2x the stake; raise doubles the stake', () => {
    let s = fresh();
    s = engine.act(s, 'b', { type: 'chaal' }).state; // blind 10
    expect(s.players[1].stack).toBe(980);
    s = engine.act(s, 'c', { type: 'see' }).state;
    expect(engine.legalActions(s, 'c')).toContainEqual({ type: 'chaal', amount: 20 });
    s = engine.act(s, 'c', { type: 'raise' }).state; // seen raise 40, stake -> 20
    expect(s.stake).toBe(20);
    expect(s.players[2].stack).toBe(950);
    expect(s.pot).toBe(30 + 10 + 40);
  });

  it('awards the pot to the last player standing', () => {
    let s = fresh();
    const before = total(s);
    s = engine.act(s, 'b', { type: 'pack' }).state;
    s = engine.act(s, 'c', { type: 'pack' }).state;
    expect(s.phase).toBe('COMPLETE');
    expect(s.winners).toEqual(['a']);
    expect(total(s)).toBe(before);
    const r = engine.results(s);
    expect(r.find((x) => x.userId === 'a')!.delta).toBe(20);
  });

  it('resolves a show; the requester loses ties', () => {
    let s = rig(fresh(), { a: 'Kc Td 5h', b: 'Kd Th 5c', c: '2c 3d 7h' });
    s = engine.act(s, 'b', { type: 'chaal' }).state;
    s = engine.act(s, 'c', { type: 'pack' }).state;
    s = engine.act(s, 'a', { type: 'show' }).state;
    expect(s.phase).toBe('COMPLETE');
    expect(s.endReason).toBe('SHOW');
    expect(s.winners).toEqual(['b']);
  });

  it('runs a side show: loser packs and play continues', () => {
    let s = rig(fresh(), { a: 'Ac Ad Ah', b: '2c 5d 9h', c: '3c 3d Kh' });
    s = engine.act(s, 'b', { type: 'see' }).state;
    s = engine.act(s, 'b', { type: 'chaal' }).state;
    s = engine.act(s, 'c', { type: 'see' }).state;
    expect(engine.legalActions(s, 'c').some((a) => a.type === 'sideshow')).toBe(true);
    s = engine.act(s, 'c', { type: 'sideshow' }).state;
    expect(s.phase).toBe('SIDESHOW');
    expect(engine.pendingActors(s)).toEqual(['b']);
    s = engine.act(s, 'b', { type: 'sideshow_accept' }).state;
    expect(s.players[1].folded).toBe(true); // pair of 3s beats 9-high
    expect(s.players[s.turnIndex].userId).toBe('a');
  });

  it('rejects out-of-turn actions and packs on timeout', () => {
    const s = fresh();
    expect(() => engine.act(s, 'a', { type: 'chaal' })).toThrow('not your turn');
    const t = engine.onTimeout(s);
    expect(t.state.players[1].folded).toBe(true);
    expect(t.events[0].type).toBe('TIMEOUT');
  });

  it('forces a showdown at the pot limit', () => {
    const cfg = engine.normalizeConfig({ boot: 10, potLimit: 100 });
    let s = engine.start(players, cfg, { handNumber: 1, rng: new SeededRng(seed) }).state;
    rig(s, { a: 'Ac Ad Ah', b: '2c 5d 9h', c: '3c 3d Kh' });
    while (s.phase !== 'COMPLETE') s = engine.act(s, s.players[s.turnIndex].userId, { type: 'raise' }).state;
    expect(s.endReason).toBe('POT_LIMIT');
    expect(s.winners).toEqual(['a']);
  });

  it('never leaks unseen cards in private views or events', () => {
    const r = engine.start(players, config, { handNumber: 1, rng: new SeededRng(seed) });
    for (const e of r.events) expect(JSON.stringify(e.payload)).not.toMatch(/"cards":\[/);
    const seen = engine.act(r.state, 'a', { type: 'see' });
    const priv = seen.events.find((e) => e.type === 'CARDS_REVEALED_PRIVATE')!;
    expect(priv.to).toEqual(['a']);
  });
});
