import {
  assert,
  EngineEvent,
  GameEngine,
  GameRuleError,
  HandContext,
  intArg,
  PlayerAction,
  PlayerResult,
  SeatedPlayer,
  StepResult,
} from '../core/engine';
import { Rng } from '../core/rng';

export interface GoldMinesConfig {
  gridSize: number; // tiles = gridSize^2
  minBet: number;
  maxBet: number;
  /** House edge applied to the fair multiplier (0.03 = 3%). */
  edge: number;
  roundSeconds: number;
}

export type MinerStatus = 'WAITING' | 'DIGGING' | 'CASHED_OUT' | 'BUSTED';

export interface Miner {
  userId: string;
  seat: number;
  name: string;
  startStack: number;
  stack: number;
  status: MinerStatus;
  bet: number;
  mineCount: number;
  mines: number[];
  revealed: number[];
  hitMine: number | null;
  payout: number;
}

export interface GoldMinesState {
  game: 'GOLD_MINES';
  handNumber: number;
  config: GoldMinesConfig;
  phase: 'OPEN' | 'COMPLETE';
  miners: Miner[];
}

const DEFAULTS: GoldMinesConfig = { gridSize: 5, minBet: 10, maxBet: 5000, edge: 0.03, roundSeconds: 90 };

/**
 * Fair multiplier after `k` safe reveals with `m` mines on `t` tiles:
 *   (1 - edge) * prod_{i<k} (t - i) / (t - m - i)
 * i.e. the inverse probability of surviving k picks, less the house edge.
 */
export function minesMultiplier(tiles: number, mines: number, safeReveals: number, edge: number): number {
  if (safeReveals === 0) return 1;
  let m = 1;
  for (let i = 0; i < safeReveals; i++) m *= (tiles - i) / (tiles - mines - i);
  return Math.floor(m * (1 - edge) * 100) / 100;
}

/**
 * Gold Mines: each player stakes chips, chooses how many mines hide in the grid, then digs
 * tiles. Every gold tile raises the multiplier; the player may cash out at any time, but
 * hitting a mine loses the stake. Mine positions are drawn by the server RNG when the player
 * starts digging and are only revealed when their round ends.
 */
export class GoldMinesEngine implements GameEngine<GoldMinesState, GoldMinesConfig> {
  readonly code = 'GOLD_MINES' as const;
  readonly minPlayers = 1;
  readonly maxPlayers = 8;
  readonly defaultConfig = DEFAULTS;

  normalizeConfig(input?: Partial<GoldMinesConfig>): GoldMinesConfig {
    const c = { ...DEFAULTS, ...(input ?? {}) };
    assert(c.gridSize >= 3 && c.gridSize <= 7, 'Grid size must be 3-7', 'BAD_CONFIG');
    assert(c.minBet >= 1 && c.maxBet >= c.minBet, 'Invalid bet limits', 'BAD_CONFIG');
    assert(c.edge >= 0 && c.edge < 0.2, 'Edge must be 0-20%', 'BAD_CONFIG');
    assert(c.roundSeconds >= 20 && c.roundSeconds <= 300, 'Round time must be 20-300s', 'BAD_CONFIG');
    return c;
  }

  minStackToPlay(c: GoldMinesConfig): number {
    return c.minBet;
  }

  start(seated: SeatedPlayer[], config: GoldMinesConfig, ctx: HandContext): StepResult<GoldMinesState> {
    const s: GoldMinesState = {
      game: 'GOLD_MINES',
      handNumber: ctx.handNumber,
      config,
      phase: 'OPEN',
      miners: [...seated]
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({
          userId: p.userId,
          seat: p.seat,
          name: p.name,
          startStack: p.stack,
          stack: p.stack,
          status: 'WAITING',
          bet: 0,
          mineCount: 0,
          mines: [],
          revealed: [],
          hitMine: null,
          payout: 0,
        })),
    };
    return {
      state: s,
      events: [{ type: 'HAND_STARTED', payload: { handNumber: ctx.handNumber, seconds: config.roundSeconds, gridSize: config.gridSize } }],
    };
  }

  private tiles(s: GoldMinesState) {
    return s.config.gridSize * s.config.gridSize;
  }

  legalActions(s: GoldMinesState, userId: string): Record<string, unknown>[] {
    const m = s.miners.find((x) => x.userId === userId);
    if (!m || s.phase !== 'OPEN') return [];
    if (m.status === 'WAITING')
      return [{ type: 'start', min: s.config.minBet, max: s.config.maxBet, mines: [1, this.tiles(s) - 1] }, { type: 'skip' }];
    if (m.status === 'DIGGING') {
      const out: Record<string, unknown>[] = [{ type: 'reveal' }];
      if (m.revealed.length > 0) out.push({ type: 'cashout', amount: this.cashValue(s, m) });
      return out;
    }
    return [];
  }

  private cashValue(s: GoldMinesState, m: Miner): number {
    return Math.floor(m.bet * minesMultiplier(this.tiles(s), m.mineCount, m.revealed.length, s.config.edge));
  }

  act(input: GoldMinesState, userId: string, action: PlayerAction, rng: Rng): StepResult<GoldMinesState> {
    assert(input.phase === 'OPEN', 'Round is over', 'HAND_OVER');
    const s: GoldMinesState = { ...input, miners: input.miners.map((m) => ({ ...m, mines: [...m.mines], revealed: [...m.revealed] })) };
    const m = s.miners.find((x) => x.userId === userId);
    assert(m, 'You are not seated at this table', 'NOT_IN_HAND');
    const events: EngineEvent[] = [];
    const tiles = this.tiles(s);

    switch (action.type) {
      case 'start': {
        assert(m.status === 'WAITING', 'You have already started this round');
        const bet = intArg(action, 'amount');
        const mineCount = intArg(action, 'mines');
        assert(bet >= s.config.minBet && bet <= s.config.maxBet, `Bet must be ${s.config.minBet}-${s.config.maxBet}`, 'BAD_ARGUMENT');
        assert(mineCount >= 1 && mineCount < tiles, `Mines must be 1-${tiles - 1}`, 'BAD_ARGUMENT');
        assert(m.stack >= bet, 'Not enough chips', 'INSUFFICIENT_CHIPS');
        m.stack -= bet;
        m.bet = bet;
        m.mineCount = mineCount;
        // Partial Fisher-Yates to pick mine positions.
        const pool = Array.from({ length: tiles }, (_, i) => i);
        for (let i = 0; i < mineCount; i++) {
          const j = i + rng.int(tiles - i);
          [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        m.mines = pool.slice(0, mineCount).sort((a, b) => a - b);
        m.status = 'DIGGING';
        events.push({ type: 'MINER_STARTED', payload: { userId, bet, mines: mineCount } });
        events.push({ type: 'CHIPS_TO_POT', payload: { from: [userId], amount: bet } });
        break;
      }
      case 'skip': {
        assert(m.status === 'WAITING', 'You have already started this round');
        m.status = 'CASHED_OUT';
        events.push({ type: 'MINER_SKIPPED', payload: { userId } });
        break;
      }
      case 'reveal': {
        assert(m.status === 'DIGGING', 'Start digging first');
        const tile = intArg(action, 'tile');
        assert(tile < tiles, 'Tile out of range', 'BAD_ARGUMENT');
        assert(!m.revealed.includes(tile), 'Tile already revealed', 'BAD_ARGUMENT');
        if (m.mines.includes(tile)) {
          m.status = 'BUSTED';
          m.hitMine = tile;
          events.push({ type: 'MINE_HIT', payload: { userId, tile, mines: m.mines } });
        } else {
          m.revealed.push(tile);
          const multiplier = minesMultiplier(tiles, m.mineCount, m.revealed.length, s.config.edge);
          events.push({ type: 'GOLD_FOUND', payload: { userId, tile, multiplier, cashValue: this.cashValue(s, m) } });
          if (m.revealed.length === tiles - m.mineCount) this.cashOut(s, m, events);
        }
        break;
      }
      case 'cashout': {
        assert(m.status === 'DIGGING', 'Nothing to cash out');
        assert(m.revealed.length > 0, 'Reveal at least one tile before cashing out');
        this.cashOut(s, m, events);
        break;
      }
      default:
        throw new GameRuleError(`Unknown action "${action.type}"`, 'UNKNOWN_ACTION');
    }
    if (s.miners.every((x) => x.status === 'CASHED_OUT' || x.status === 'BUSTED')) this.complete(s, events);
    return { state: s, events };
  }

  private cashOut(s: GoldMinesState, m: Miner, events: EngineEvent[]) {
    m.payout = this.cashValue(s, m);
    m.stack += m.payout;
    m.status = 'CASHED_OUT';
    events.push({ type: 'CASHED_OUT', payload: { userId: m.userId, amount: m.payout, mines: m.mines } });
    events.push({ type: 'POT_TO_WINNER', payload: { winners: [m.userId], amount: m.payout } });
  }

  private complete(s: GoldMinesState, events: EngineEvent[]) {
    s.phase = 'COMPLETE';
    events.push({
      type: 'HAND_COMPLETE',
      payload: { results: s.miners.map((m) => ({ userId: m.userId, status: m.status, bet: m.bet, payout: m.payout })) },
    });
  }

  onTimeout(input: GoldMinesState): StepResult<GoldMinesState> {
    if (input.phase !== 'OPEN') return { state: input, events: [] };
    const s: GoldMinesState = { ...input, miners: input.miners.map((m) => ({ ...m })) };
    const events: EngineEvent[] = [{ type: 'ROUND_TIMEOUT', payload: {} }];
    for (const m of s.miners) {
      if (m.status === 'WAITING') m.status = 'CASHED_OUT';
      else if (m.status === 'DIGGING') {
        if (m.revealed.length) this.cashOut(s, m, events);
        else {
          // No tiles dug: refund the stake.
          m.stack += m.bet;
          m.payout = m.bet;
          m.status = 'CASHED_OUT';
          events.push({ type: 'STAKE_REFUNDED', payload: { userId: m.userId, amount: m.bet } });
        }
      }
    }
    this.complete(s, events);
    return { state: s, events };
  }

  pendingActors(s: GoldMinesState): string[] {
    return s.phase === 'OPEN' ? s.miners.filter((m) => m.status === 'WAITING' || m.status === 'DIGGING').map((m) => m.userId) : [];
  }

  timeoutSeconds(_s: GoldMinesState, c: GoldMinesConfig): number {
    return c.roundSeconds;
  }

  view(s: GoldMinesState, viewerId: string | null): Record<string, unknown> {
    const tiles = this.tiles(s);
    return {
      game: s.game,
      handNumber: s.handNumber,
      phase: s.phase,
      gridSize: s.config.gridSize,
      minBet: s.config.minBet,
      maxBet: s.config.maxBet,
      players: s.miners.map((m) => {
        const finished = m.status === 'BUSTED' || m.status === 'CASHED_OUT';
        return {
          userId: m.userId,
          seat: m.seat,
          name: m.name,
          stack: m.stack,
          status: m.status,
          bet: m.bet,
          mineCount: m.mineCount,
          revealed: m.revealed,
          hitMine: m.hitMine,
          payout: m.payout,
          multiplier: minesMultiplier(tiles, m.mineCount || 1, m.revealed.length, s.config.edge),
          nextMultiplier: m.status === 'DIGGING' ? minesMultiplier(tiles, m.mineCount, m.revealed.length + 1, s.config.edge) : null,
          // Mine positions are revealed only once that player's round is over.
          mines: finished || (viewerId === null && s.phase === 'COMPLETE') ? m.mines : null,
        };
      }),
    };
  }

  isComplete(s: GoldMinesState): boolean {
    return s.phase === 'COMPLETE';
  }

  results(s: GoldMinesState): PlayerResult[] {
    return s.miners.map((m) => {
      const delta = m.stack - m.startStack;
      return {
        userId: m.userId,
        delta,
        outcome: m.bet === 0 ? 'DRAW' : delta > 0 ? 'WIN' : delta < 0 ? 'LOSS' : 'DRAW',
        details: { bet: m.bet, mines: m.mineCount, revealed: m.revealed.length, busted: m.status === 'BUSTED' },
      };
    });
  }

  finalStacks(s: GoldMinesState): Record<string, number> {
    return Object.fromEntries(s.miners.map((m) => [m.userId, m.stack]));
  }
}
