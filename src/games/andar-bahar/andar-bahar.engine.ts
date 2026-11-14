import { Card, createDeck, rankOf, shuffle } from '../core/cards';
import { Bettor, clearBets, makeBettors, placeBet, totalBet } from '../core/betting-round';
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

export interface AndarBaharConfig {
  minBet: number;
  maxBet: number;
  bettingSeconds: number;
}

type Side = 'ANDAR' | 'BAHAR';
const SPOTS = ['ANDAR', 'BAHAR'] as const;

export interface AndarBaharState {
  game: 'ANDAR_BAHAR';
  handNumber: number;
  config: AndarBaharConfig;
  phase: 'BETTING' | 'COMPLETE';
  bettors: Bettor[];
  deck: Card[];
  joker: Card | null;
  /** Side that receives the first dealt card. */
  firstSide: Side | null;
  andar: Card[];
  bahar: Card[];
  winningSide: Side | null;
}

const DEFAULTS: AndarBaharConfig = { minBet: 10, maxBet: 5000, bettingSeconds: 15 };

/**
 * Andar Bahar: a joker (game card) is opened, then cards are dealt alternately to Andar and
 * Bahar until a card of the same rank appears. Dealing starts on Andar when the joker is
 * black and on Bahar when red. The side dealt first pays 0.9:1 (it has a slight edge);
 * the other side pays 1:1.
 */
export class AndarBaharEngine implements GameEngine<AndarBaharState, AndarBaharConfig> {
  readonly code = 'ANDAR_BAHAR' as const;
  readonly minPlayers = 1;
  readonly maxPlayers = 10;
  readonly defaultConfig = DEFAULTS;

  normalizeConfig(input?: Partial<AndarBaharConfig>): AndarBaharConfig {
    const c = { ...DEFAULTS, ...(input ?? {}) };
    assert(c.minBet >= 1 && c.maxBet >= c.minBet, 'Invalid bet limits', 'BAD_CONFIG');
    assert(c.bettingSeconds >= 5 && c.bettingSeconds <= 60, 'Betting window must be 5-60s', 'BAD_CONFIG');
    return c;
  }

  minStackToPlay(c: AndarBaharConfig): number {
    return c.minBet;
  }

  start(seated: SeatedPlayer[], config: AndarBaharConfig, ctx: HandContext): StepResult<AndarBaharState> {
    const s: AndarBaharState = {
      game: 'ANDAR_BAHAR',
      handNumber: ctx.handNumber,
      config,
      phase: 'BETTING',
      bettors: makeBettors(seated),
      deck: shuffle(createDeck(), ctx.rng),
      joker: null,
      firstSide: null,
      andar: [],
      bahar: [],
      winningSide: null,
    };
    // The joker is opened before betting so players can choose a side.
    s.joker = s.deck.pop()!;
    // Black joker (spades/clubs) -> first card to Andar; red -> Bahar.
    s.firstSide = ['s', 'c'].includes(s.joker[1]) ? 'ANDAR' : 'BAHAR';
    return {
      state: s,
      events: [
        { type: 'HAND_STARTED', payload: { handNumber: ctx.handNumber } },
        { type: 'JOKER_OPENED', payload: { card: s.joker, firstSide: s.firstSide } },
        { type: 'BETTING_OPEN', payload: { seconds: config.bettingSeconds } },
      ],
    };
  }

  legalActions(s: AndarBaharState, userId: string): Record<string, unknown>[] {
    const b = s.bettors.find((x) => x.userId === userId);
    if (!b || s.phase !== 'BETTING' || b.ready) return [];
    return [{ type: 'bet', spots: SPOTS, min: s.config.minBet, max: s.config.maxBet }, { type: 'clear' }, { type: 'ready' }];
  }

  act(input: AndarBaharState, userId: string, action: PlayerAction): StepResult<AndarBaharState> {
    assert(input.phase === 'BETTING', 'Betting is closed', 'HAND_OVER');
    const s: AndarBaharState = { ...input, bettors: input.bettors.map((b) => ({ ...b, bets: { ...b.bets } })) };
    const b = s.bettors.find((x) => x.userId === userId);
    assert(b, 'You are not seated at this table', 'NOT_IN_HAND');
    const events: EngineEvent[] = [];
    if (action.type === 'bet') {
      placeBet(b, action, SPOTS, s.config);
      events.push({ type: 'BET_PLACED', payload: { userId, spot: action.spot, amount: action.amount, bets: b.bets } });
      events.push({ type: 'CHIPS_TO_SPOT', payload: { from: userId, spot: action.spot, amount: action.amount } });
    } else if (action.type === 'clear') {
      clearBets(b);
      events.push({ type: 'BETS_CLEARED', payload: { userId } });
    } else if (action.type === 'ready') {
      b.ready = true;
      events.push({ type: 'PLAYER_READY', payload: { userId } });
      if (s.bettors.every((x) => x.ready)) return this.deal(s, events);
    } else {
      throw new GameRuleError(`Unknown action "${action.type}"`, 'UNKNOWN_ACTION');
    }
    return { state: s, events };
  }

  private deal(s: AndarBaharState, events: EngineEvent[]): StepResult<AndarBaharState> {
    const target = rankOf(s.joker!);
    let side: Side = s.firstSide!;
    const sequence: { side: Side; card: Card }[] = [];
    while (s.deck.length) {
      const card = s.deck.pop()!;
      (side === 'ANDAR' ? s.andar : s.bahar).push(card);
      sequence.push({ side, card });
      if (rankOf(card) === target) {
        s.winningSide = side;
        break;
      }
      side = side === 'ANDAR' ? 'BAHAR' : 'ANDAR';
    }
    events.push({ type: 'BETTING_CLOSED', payload: {} });
    events.push({ type: 'DEAL_SEQUENCE', payload: { cards: sequence } });
    for (const b of s.bettors) {
      const stake = b.bets[s.winningSide!] ?? 0;
      if (stake > 0) {
        const profit = s.winningSide === s.firstSide ? Math.floor(stake * 0.9) : stake;
        b.payout = stake + profit;
        b.stack += b.payout;
      }
    }
    s.phase = 'COMPLETE';
    const winners = s.bettors.filter((b) => b.payout > 0).map((b) => b.userId);
    events.push({ type: 'HAND_COMPLETE', payload: { winningSide: s.winningSide, cardsDealt: sequence.length, winners } });
    if (winners.length)
      events.push({ type: 'POT_TO_WINNER', payload: { winners, payouts: Object.fromEntries(s.bettors.map((b) => [b.userId, b.payout])) } });
    return { state: s, events };
  }

  onTimeout(s: AndarBaharState, _rng: Rng): StepResult<AndarBaharState> {
    if (s.phase !== 'BETTING') return { state: s, events: [] };
    const copy: AndarBaharState = { ...s, bettors: s.bettors.map((b) => ({ ...b, ready: true })) };
    return this.deal(copy, []);
  }

  pendingActors(s: AndarBaharState): string[] {
    return s.phase === 'BETTING' ? s.bettors.filter((b) => !b.ready).map((b) => b.userId) : [];
  }

  timeoutSeconds(_s: AndarBaharState, c: AndarBaharConfig): number {
    return c.bettingSeconds;
  }

  view(s: AndarBaharState): Record<string, unknown> {
    return {
      game: s.game,
      handNumber: s.handNumber,
      phase: s.phase,
      joker: s.joker,
      firstSide: s.firstSide,
      andar: s.andar,
      bahar: s.bahar,
      winningSide: s.winningSide,
      minBet: s.config.minBet,
      maxBet: s.config.maxBet,
      players: s.bettors.map((b) => ({
        userId: b.userId,
        seat: b.seat,
        name: b.name,
        stack: b.stack,
        bets: b.bets,
        ready: b.ready,
        payout: b.payout,
      })),
    };
  }

  isComplete(s: AndarBaharState): boolean {
    return s.phase === 'COMPLETE';
  }

  results(s: AndarBaharState): PlayerResult[] {
    return s.bettors.map((b) => {
      const delta = b.stack - b.startStack;
      return {
        userId: b.userId,
        delta,
        outcome: totalBet(b) === 0 ? 'DRAW' : delta > 0 ? 'WIN' : delta < 0 ? 'LOSS' : 'DRAW',
        details: { bets: b.bets, winningSide: s.winningSide },
      };
    });
  }

  finalStacks(s: AndarBaharState): Record<string, number> {
    return Object.fromEntries(s.bettors.map((b) => [b.userId, b.stack]));
  }
}
