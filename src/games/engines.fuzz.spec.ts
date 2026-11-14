import { randomBytes } from 'crypto';
import { SeededRng } from './core/rng';
import { GAME_CODES, getEngine } from './registry';

/**
 * Plays many hands of every game with random legal actions and checks invariants:
 *  - hands always terminate, no illegal-action exceptions from legal moves
 *  - peer-to-peer games conserve chips exactly
 *  - views never expose another player's hidden cards mid-hand
 */
const PEER_GAMES = new Set(['TEEN_PATTI', 'POKER', 'OMAHA', 'RUMMY']);

function randomAction(legal: Record<string, unknown>[], r: SeededRng, state: any, userId: string) {
  const a = { ...legal[r.int(legal.length)] } as { type: string; [k: string]: unknown };
  if ((a.type === 'raise' || a.type === 'bet') && typeof a.min === 'number') {
    const min = a.min as number;
    const max = a.max as number;
    a.amount = min + r.int(max - min + 1);
  }
  if (a.type === 'bet' && Array.isArray(a.spots)) {
    a.spot = (a.spots as string[])[r.int((a.spots as string[]).length)];
    a.amount = 10 + r.int(50);
  }
  if (a.type === 'discard' || a.type === 'declare') {
    const me = state.players.find((p: any) => p.userId === userId);
    const choices = me.hand.filter((c: string) => c !== state.lastPickedFromDiscard);
    a.card = choices[r.int(choices.length)];
  }
  if (a.type === 'start') {
    a.amount = 10 + r.int(100);
    a.mines = 1 + r.int(10);
  }
  if (a.type === 'reveal') {
    const me = state.miners.find((m: any) => m.userId === userId);
    const options = [...Array(25).keys()].filter((t) => !me.revealed.includes(t));
    a.tile = options[r.int(options.length)];
  }
  return a;
}

describe.each(GAME_CODES)('%s fuzz', (code) => {
  const engine = getEngine(code);
  it('plays 150 random hands without breaking invariants', () => {
    for (let hand = 1; hand <= 150; hand++) {
      const r = new SeededRng(randomBytes(32).toString('hex'));
      const n = Math.max(engine.minPlayers, 2) + r.int(Math.min(engine.maxPlayers, 6) - Math.max(engine.minPlayers, 2) + 1);
      const players = Array.from({ length: n }, (_, i) => ({ userId: `p${i}`, seat: i, name: `P${i}`, stack: 300 + r.int(2000) }));
      const total = players.reduce((t, p) => t + p.stack, 0);
      const config = engine.normalizeConfig({});
      let { state } = engine.start(players, config, { handNumber: hand, rng: r });
      let steps = 0;
      while (!engine.isComplete(state)) {
        if (++steps > 2000) throw new Error(`${code}: hand did not terminate`);
        const pending = engine.pendingActors(state);
        // Occasionally exercise the timeout path.
        if (pending.length === 0 || r.int(20) === 0) {
          state = engine.onTimeout(state, r).state;
          continue;
        }
        const uid = pending[r.int(pending.length)];
        const legal = engine.legalActions(state, uid).filter((a) => a.type !== 'see' || r.int(3) === 0);
        if (!legal.length) {
          state = engine.onTimeout(state, r).state;
          continue;
        }
        const action = randomAction(legal, r, state, uid);
        try {
          state = engine.act(state, uid, action, r).state;
        } catch (e) {
          // Random amounts can exceed stacks for betting games; anything else is a bug.
          if (!/Not enough chips|Maximum bet|Minimum bet/.test((e as Error).message)) {
            throw new Error(`${code}: legal action ${JSON.stringify(action)} rejected: ${(e as Error).message}`);
          }
        }
        // Mid-hand, a viewer must never see another player's cards.
        const v = engine.view(state, 'p0') as { players: { userId: string; cards?: unknown }[] };
        if (!engine.isComplete(state) && code !== 'RUMMY') {
          for (const p of v.players) if (p.userId !== 'p0' && 'cards' in p) expect(p.cards).toBeNull();
        }
      }
      const stacks = engine.finalStacks(state);
      const after = Object.values(stacks).reduce((a, b) => a + b, 0);
      const deltas = engine.results(state);
      for (const d of deltas) expect(stacks[d.userId] - players.find((p) => p.userId === d.userId)!.stack).toBe(d.delta);
      if (PEER_GAMES.has(code)) expect(after).toBe(total);
      for (const s of Object.values(stacks)) expect(s).toBeGreaterThanOrEqual(0);
    }
  });
});
