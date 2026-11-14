import { createDeck, rankOf, shuffle } from '../core/cards';
import {
  assert,
  EngineEvent,
  GameEngine,
  GameRuleError,
  HandContext,
  PlayerAction,
  PlayerResult,
  SeatedPlayer,
  StepResult,
} from '../core/engine';
import { Rng } from '../core/rng';
import { Arrangement, baseOf, bestArrangement, isJoker } from './rummy.melds';

export interface RummyConfig {
  /** Chips per point. */
  pointValue: number;
  maxPoints: number;
  firstDropPoints: number;
  middleDropPoints: number;
  turnSeconds: number;
  /** Consecutive timeouts before a player is auto-dropped. */
  maxMissedTurns: number;
}

export type RummyStatus = 'PLAYING' | 'DROPPED' | 'WRONG_SHOW' | 'WINNER' | 'LOST';

export interface RummyPlayer {
  userId: string;
  seat: number;
  name: string;
  startStack: number;
  stack: number;
  hand: string[];
  status: RummyStatus;
  hasDrawnOnce: boolean;
  missedTurns: number;
  points: number;
  arrangement: Arrangement | null;
}

export interface RummyState {
  game: 'RUMMY';
  handNumber: number;
  config: RummyConfig;
  phase: 'DRAW' | 'DISCARD' | 'COMPLETE';
  players: RummyPlayer[];
  stock: string[];
  discard: string[];
  wildCard: string;
  wildRank: number;
  dealerIndex: number;
  turnIndex: number;
  /** Card just taken from the discard pile (cannot be discarded straight back). */
  lastPickedFromDiscard: string | null;
  winner: string | null;
}

const DEFAULTS: RummyConfig = {
  pointValue: 1,
  maxPoints: 80,
  firstDropPoints: 20,
  middleDropPoints: 40,
  turnSeconds: 30,
  maxMissedTurns: 3,
};

function clone(s: RummyState): RummyState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, hand: [...p.hand] })),
    stock: [...s.stock],
    discard: [...s.discard],
  };
}

export class RummyEngine implements GameEngine<RummyState, RummyConfig> {
  readonly code = 'RUMMY' as const;
  readonly minPlayers = 2;
  readonly maxPlayers = 6;
  readonly defaultConfig = DEFAULTS;

  normalizeConfig(input?: Partial<RummyConfig>): RummyConfig {
    const c = { ...DEFAULTS, ...(input ?? {}) };
    assert(Number.isInteger(c.pointValue) && c.pointValue >= 1, 'Point value must be >= 1', 'BAD_CONFIG');
    assert(c.turnSeconds >= 10 && c.turnSeconds <= 120, 'Turn time must be 10-120s', 'BAD_CONFIG');
    return c;
  }

  minStackToPlay(c: RummyConfig): number {
    return c.maxPoints * c.pointValue;
  }

  start(seated: SeatedPlayer[], config: RummyConfig, ctx: HandContext): StepResult<RummyState> {
    assert(seated.length >= 2 && seated.length <= 6, 'Rummy needs 2-6 players');
    const ordered = [...seated].sort((a, b) => a.seat - b.seat);
    // Two decks + two printed jokers; ids are made unique per deck.
    const base = createDeck(1, 2);
    const ids = [...base.map((c) => `${c}#0`), ...base.map((c) => `${c}#1`)];
    const deck = shuffle(ids, ctx.rng);
    const dealerIndex = (ctx.handNumber - 1) % ordered.length;
    const players: RummyPlayer[] = ordered.map((p) => ({
      userId: p.userId,
      seat: p.seat,
      name: p.name,
      startStack: p.stack,
      stack: p.stack,
      hand: [],
      status: 'PLAYING',
      hasDrawnOnce: false,
      missedTurns: 0,
      points: 0,
      arrangement: null,
    }));
    for (let r = 0; r < 13; r++)
      for (let i = 1; i <= players.length; i++) players[(dealerIndex + i) % players.length].hand.push(deck.pop()!);

    // Cut the wild joker; a printed joker cut makes Aces wild.
    const wildCard = deck.shift()!;
    const wildRank = baseOf(wildCard)[0] === 'X' ? 14 : rankOf(baseOf(wildCard));
    const discard = [deck.pop()!];

    const s: RummyState = {
      game: 'RUMMY',
      handNumber: ctx.handNumber,
      config,
      phase: 'DRAW',
      players,
      stock: deck,
      discard,
      wildCard,
      wildRank,
      dealerIndex,
      turnIndex: (dealerIndex + 1) % players.length,
      lastPickedFromDiscard: null,
      winner: null,
    };
    const events: EngineEvent[] = [
      { type: 'HAND_STARTED', payload: { handNumber: ctx.handNumber, dealerSeat: players[dealerIndex].seat } },
      { type: 'CARDS_DEALT', payload: { seats: players.map((p) => p.seat), cardsEach: 13, faceDown: true } },
      ...players.map((p) => ({ type: 'HAND_CARDS', payload: { cards: p.hand }, to: [p.userId] })),
      { type: 'WILD_JOKER', payload: { card: wildCard, rank: wildRank } },
      { type: 'DISCARD_OPENED', payload: { card: discard[0] } },
      { type: 'TURN', payload: { userId: players[s.turnIndex].userId, phase: 'DRAW' } },
    ];
    return { state: s, events };
  }

  private playing(s: RummyState) {
    return s.players.filter((p) => p.status === 'PLAYING');
  }

  legalActions(s: RummyState, userId: string): Record<string, unknown>[] {
    if (s.phase === 'COMPLETE') return [];
    const p = s.players[s.turnIndex];
    if (p.userId !== userId) return [];
    if (s.phase === 'DRAW') {
      const out: Record<string, unknown>[] = [{ type: 'draw', from: 'stock' }];
      const top = s.discard[s.discard.length - 1];
      if (top && !isJoker(top, s.wildRank)) out.push({ type: 'draw', from: 'discard', card: top });
      out.push({ type: 'drop', points: p.hasDrawnOnce ? s.config.middleDropPoints : s.config.firstDropPoints });
      return out;
    }
    return [{ type: 'discard' }, { type: 'declare' }];
  }

  act(input: RummyState, userId: string, action: PlayerAction, rng: Rng): StepResult<RummyState> {
    assert(input.phase !== 'COMPLETE', 'Hand is over', 'HAND_OVER');
    const s = clone(input);
    const p = s.players[s.turnIndex];
    assert(p.userId === userId, 'It is not your turn', 'NOT_YOUR_TURN');
    const events: EngineEvent[] = [];
    p.missedTurns = action.auto ? p.missedTurns : 0;

    switch (action.type) {
      case 'draw': {
        assert(s.phase === 'DRAW', 'You have already drawn; discard a card');
        const from = action.from === 'discard' ? 'discard' : 'stock';
        let card: string;
        if (from === 'discard') {
          const top = s.discard[s.discard.length - 1];
          assert(top, 'Discard pile is empty');
          assert(!isJoker(top, s.wildRank), 'A joker cannot be picked from the discard pile');
          card = s.discard.pop()!;
          s.lastPickedFromDiscard = card;
        } else {
          if (s.stock.length === 0) this.reshuffle(s, rng, events);
          card = s.stock.pop()!;
          s.lastPickedFromDiscard = null;
        }
        p.hand.push(card);
        p.hasDrawnOnce = true;
        s.phase = 'DISCARD';
        events.push({ type: 'CARD_DRAWN', payload: { userId, from, card: from === 'discard' ? card : null } });
        events.push({ type: 'CARD_DRAWN_PRIVATE', payload: { card }, to: [userId] });
        return { state: s, events };
      }
      case 'discard': {
        assert(s.phase === 'DISCARD', 'Draw a card first');
        const card = this.cardArg(p, action);
        assert(card !== s.lastPickedFromDiscard || action.auto, 'You cannot discard the card you just picked up');
        p.hand.splice(p.hand.indexOf(card), 1);
        s.discard.push(card);
        events.push({ type: 'CARD_DISCARDED', payload: { userId, card } });
        return this.advance(s, events);
      }
      case 'declare': {
        assert(s.phase === 'DISCARD', 'Draw a card before declaring');
        const card = this.cardArg(p, action);
        p.hand.splice(p.hand.indexOf(card), 1);
        s.discard.push(card);
        const arr = bestArrangement(p.hand, s.wildRank);
        p.arrangement = arr;
        events.push({ type: 'DECLARED', payload: { userId, valid: arr.valid } });
        if (arr.valid) return this.finish(s, p, events);
        // Wrong show: full penalty, player is out, game continues.
        p.status = 'WRONG_SHOW';
        p.points = s.config.maxPoints;
        events.push({ type: 'WRONG_SHOW', payload: { userId, points: p.points, arrangement: arr } });
        return this.advance(s, events, true);
      }
      case 'drop': {
        assert(s.phase === 'DRAW', 'You can only drop before drawing');
        p.status = 'DROPPED';
        p.points = p.hasDrawnOnce ? s.config.middleDropPoints : s.config.firstDropPoints;
        events.push({ type: 'PLAYER_DROPPED', payload: { userId, points: p.points } });
        return this.advance(s, events, true);
      }
      default:
        throw new GameRuleError(`Unknown action "${action.type}"`, 'UNKNOWN_ACTION');
    }
  }

  private cardArg(p: RummyPlayer, action: PlayerAction): string {
    const card = action.card;
    assert(typeof card === 'string' && p.hand.includes(card), 'You do not hold that card', 'BAD_ARGUMENT');
    return card;
  }

  private reshuffle(s: RummyState, rng: Rng, events: EngineEvent[]) {
    const top = s.discard.pop()!;
    s.stock = shuffle(s.discard, rng);
    s.discard = [top];
    events.push({ type: 'STOCK_RESHUFFLED', payload: { stock: s.stock.length } });
  }

  private advance(s: RummyState, events: EngineEvent[], playerLeft = false): StepResult<RummyState> {
    const live = this.playing(s);
    if (live.length === 1) return this.finish(s, live[0], events);
    const n = s.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (s.turnIndex + i) % n;
      if (s.players[idx].status === 'PLAYING') {
        s.turnIndex = idx;
        break;
      }
    }
    void playerLeft;
    s.phase = 'DRAW';
    s.lastPickedFromDiscard = null;
    events.push({ type: 'TURN', payload: { userId: s.players[s.turnIndex].userId, phase: 'DRAW' } });
    return { state: s, events };
  }

  private finish(s: RummyState, winner: RummyPlayer, events: EngineEvent[]): StepResult<RummyState> {
    s.phase = 'COMPLETE';
    s.winner = winner.userId;
    winner.status = 'WINNER';
    let pool = 0;
    for (const p of s.players) {
      if (p === winner) continue;
      if (p.status === 'PLAYING') {
        p.arrangement = bestArrangement(p.hand, s.wildRank);
        p.points = Math.min(s.config.maxPoints, p.arrangement.points);
        p.status = 'LOST';
      }
      const owed = Math.min(p.stack, p.points * s.config.pointValue);
      p.stack -= owed;
      pool += owed;
    }
    winner.stack += pool;
    winner.points = 0;
    if (!winner.arrangement) winner.arrangement = bestArrangement(winner.hand, s.wildRank);
    events.push({
      type: 'HAND_COMPLETE',
      payload: {
        winners: [winner.userId],
        amount: pool,
        scores: s.players.map((p) => ({ userId: p.userId, points: p.points, status: p.status, arrangement: p.arrangement })),
      },
    });
    events.push({ type: 'POT_TO_WINNER', payload: { winners: [winner.userId], amount: pool } });
    return { state: s, events };
  }

  onTimeout(s: RummyState, rng: Rng): StepResult<RummyState> {
    if (s.phase === 'COMPLETE') return { state: s, events: [] };
    const p = s.players[s.turnIndex];
    const missed = p.missedTurns + 1;
    let r: StepResult<RummyState>;
    if (missed >= s.config.maxMissedTurns && s.phase === 'DRAW') {
      r = this.act(s, p.userId, { type: 'drop', auto: true }, rng);
    } else if (s.phase === 'DRAW') {
      const drawn = this.act(s, p.userId, { type: 'draw', from: 'stock', auto: true }, rng);
      const dp = drawn.state.players[drawn.state.turnIndex];
      const card = dp.hand[dp.hand.length - 1];
      const disc = this.act(drawn.state, p.userId, { type: 'discard', card, auto: true }, rng);
      r = { state: disc.state, events: [...drawn.events, ...disc.events] };
    } else {
      const card = p.hand[p.hand.length - 1];
      r = this.act(s, p.userId, { type: 'discard', card, auto: true }, rng);
    }
    const after = r.state.players.find((x) => x.userId === p.userId)!;
    after.missedTurns = missed;
    r.events.unshift({ type: 'TIMEOUT', payload: { userId: p.userId, missed } });
    return r;
  }

  pendingActors(s: RummyState): string[] {
    return s.phase === 'COMPLETE' ? [] : [s.players[s.turnIndex].userId];
  }

  timeoutSeconds(_s: RummyState, c: RummyConfig): number {
    return c.turnSeconds;
  }

  view(s: RummyState, viewerId: string | null): Record<string, unknown> {
    const done = s.phase === 'COMPLETE';
    return {
      game: s.game,
      handNumber: s.handNumber,
      phase: s.phase,
      wildCard: s.wildCard,
      wildRank: s.wildRank,
      stockCount: s.stock.length,
      discardTop: s.discard[s.discard.length - 1] ?? null,
      discardCount: s.discard.length,
      turnUserId: done ? null : s.players[s.turnIndex].userId,
      dealerSeat: s.players[s.dealerIndex].seat,
      winner: s.winner,
      pointValue: s.config.pointValue,
      players: s.players.map((p) => ({
        userId: p.userId,
        seat: p.seat,
        name: p.name,
        stack: p.stack,
        status: p.status,
        cardCount: p.hand.length,
        cards: p.userId === viewerId || done ? p.hand : null,
        points: done || p.status !== 'PLAYING' ? p.points : null,
        arrangement: done ? p.arrangement : null,
      })),
    };
  }

  isComplete(s: RummyState): boolean {
    return s.phase === 'COMPLETE';
  }

  results(s: RummyState): PlayerResult[] {
    return s.players.map((p) => ({
      userId: p.userId,
      delta: p.stack - p.startStack,
      outcome: p.userId === s.winner ? 'WIN' : p.status === 'DROPPED' ? 'FOLD' : 'LOSS',
      rank: p.userId === s.winner ? 1 : 2,
      details: { points: p.points, status: p.status },
    }));
  }

  finalStacks(s: RummyState): Record<string, number> {
    return Object.fromEntries(s.players.map((p) => [p.userId, p.stack]));
  }
}
