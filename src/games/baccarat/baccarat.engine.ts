import { baccaratValue, Card, createDeck, rankOf, shuffle } from '../core/cards';
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

export interface BaccaratConfig {
  minBet: number;
  maxBet: number;
  bettingSeconds: number;
  decks: number;
}

const SPOTS = ['PLAYER', 'BANKER', 'TIE', 'PLAYER_PAIR', 'BANKER_PAIR'] as const;
export type BaccaratOutcome = 'PLAYER' | 'BANKER' | 'TIE';

export interface BaccaratState {
  game: 'BACCARAT';
  handNumber: number;
  config: BaccaratConfig;
  phase: 'BETTING' | 'COMPLETE';
  bettors: Bettor[];
  shoe: Card[];
  playerHand: Card[];
  bankerHand: Card[];
  outcome: BaccaratOutcome | null;
}

const DEFAULTS: BaccaratConfig = { minBet: 10, maxBet: 5000, bettingSeconds: 15, decks: 8 };

export function handTotal(cards: Card[]): number {
  return cards.reduce((t, c) => t + baccaratValue(c), 0) % 10;
}

/** Punto Banco tableau: returns final player/banker hands drawn from the shoe (pops from end). */
export function playCoup(shoe: Card[]): { player: Card[]; banker: Card[] } {
  const player = [shoe.pop()!, null as unknown as Card];
  const banker = [shoe.pop()!, null as unknown as Card];
  player[1] = shoe.pop()!;
  banker[1] = shoe.pop()!;
  const p2 = handTotal(player);
  const b2 = handTotal(banker);
  if (p2 >= 8 || b2 >= 8) return { player, banker }; // natural

  let playerThird: Card | null = null;
  if (p2 <= 5) {
    playerThird = shoe.pop()!;
    player.push(playerThird);
  }
  let bankerDraws: boolean;
  if (playerThird === null) bankerDraws = b2 <= 5;
  else {
    const t = baccaratValue(playerThird);
    if (b2 <= 2) bankerDraws = true;
    else if (b2 === 3) bankerDraws = t !== 8;
    else if (b2 === 4) bankerDraws = t >= 2 && t <= 7;
    else if (b2 === 5) bankerDraws = t >= 4 && t <= 7;
    else if (b2 === 6) bankerDraws = t === 6 || t === 7;
    else bankerDraws = false;
  }
  if (bankerDraws) banker.push(shoe.pop()!);
  return { player, banker };
}

/**
 * Baccarat (Punto Banco). Payouts: Player 1:1, Banker 0.95:1 (5% commission), Tie 8:1
 * (Player/Banker bets push on a tie), Player Pair / Banker Pair 11:1.
 */
export class BaccaratEngine implements GameEngine<BaccaratState, BaccaratConfig> {
  readonly code = 'BACCARAT' as const;
  readonly minPlayers = 1;
  readonly maxPlayers = 10;
  readonly defaultConfig = DEFAULTS;

  normalizeConfig(input?: Partial<BaccaratConfig>): BaccaratConfig {
    const c = { ...DEFAULTS, ...(input ?? {}) };
    assert(c.minBet >= 1 && c.maxBet >= c.minBet, 'Invalid bet limits', 'BAD_CONFIG');
    assert(c.decks >= 1 && c.decks <= 8, 'Decks must be 1-8', 'BAD_CONFIG');
    assert(c.bettingSeconds >= 5 && c.bettingSeconds <= 60, 'Betting window must be 5-60s', 'BAD_CONFIG');
    return c;
  }

  minStackToPlay(c: BaccaratConfig): number {
    return c.minBet;
  }

  start(seated: SeatedPlayer[], config: BaccaratConfig, ctx: HandContext): StepResult<BaccaratState> {
    const s: BaccaratState = {
      game: 'BACCARAT',
      handNumber: ctx.handNumber,
      config,
      phase: 'BETTING',
      bettors: makeBettors(seated),
      shoe: shuffle(createDeck(config.decks), ctx.rng),
      playerHand: [],
      bankerHand: [],
      outcome: null,
    };
    return {
      state: s,
      events: [
        { type: 'HAND_STARTED', payload: { handNumber: ctx.handNumber } },
        { type: 'BETTING_OPEN', payload: { seconds: config.bettingSeconds } },
      ],
    };
  }

  legalActions(s: BaccaratState, userId: string): Record<string, unknown>[] {
    const b = s.bettors.find((x) => x.userId === userId);
    if (!b || s.phase !== 'BETTING' || b.ready) return [];
    return [{ type: 'bet', spots: SPOTS, min: s.config.minBet, max: s.config.maxBet }, { type: 'clear' }, { type: 'ready' }];
  }

  act(input: BaccaratState, userId: string, action: PlayerAction): StepResult<BaccaratState> {
    assert(input.phase === 'BETTING', 'Betting is closed', 'HAND_OVER');
    const s: BaccaratState = { ...input, bettors: input.bettors.map((b) => ({ ...b, bets: { ...b.bets } })) };
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
      if (s.bettors.every((x) => x.ready)) return this.resolve(s, events);
    } else throw new GameRuleError(`Unknown action "${action.type}"`, 'UNKNOWN_ACTION');
    return { state: s, events };
  }

  private resolve(s: BaccaratState, events: EngineEvent[]): StepResult<BaccaratState> {
    const shoe = [...s.shoe];
    const { player, banker } = playCoup(shoe);
    s.shoe = shoe;
    s.playerHand = player;
    s.bankerHand = banker;
    const pt = handTotal(player);
    const bt = handTotal(banker);
    s.outcome = pt > bt ? 'PLAYER' : bt > pt ? 'BANKER' : 'TIE';
    const playerPair = rankOf(player[0]) === rankOf(player[1]);
    const bankerPair = rankOf(banker[0]) === rankOf(banker[1]);

    for (const b of s.bettors) {
      let payout = 0;
      const bet = (k: string) => b.bets[k] ?? 0;
      if (s.outcome === 'PLAYER') payout += bet('PLAYER') * 2;
      if (s.outcome === 'BANKER') payout += bet('BANKER') + Math.floor(bet('BANKER') * 0.95);
      if (s.outcome === 'TIE') payout += bet('PLAYER') + bet('BANKER') + bet('TIE') * 9;
      if (playerPair) payout += bet('PLAYER_PAIR') * 12;
      if (bankerPair) payout += bet('BANKER_PAIR') * 12;
      b.payout = payout;
      b.stack += payout;
    }
    s.phase = 'COMPLETE';
    events.push({ type: 'BETTING_CLOSED', payload: {} });
    events.push({
      type: 'BACCARAT_DEAL',
      payload: { player, banker, playerTotal: pt, bankerTotal: bt, playerPair, bankerPair },
    });
    const winners = s.bettors.filter((b) => b.payout > totalBet(b)).map((b) => b.userId);
    events.push({ type: 'HAND_COMPLETE', payload: { outcome: s.outcome, playerTotal: pt, bankerTotal: bt, winners } });
    if (winners.length)
      events.push({ type: 'POT_TO_WINNER', payload: { winners, payouts: Object.fromEntries(s.bettors.map((b) => [b.userId, b.payout])) } });
    return { state: s, events };
  }

  onTimeout(s: BaccaratState): StepResult<BaccaratState> {
    if (s.phase !== 'BETTING') return { state: s, events: [] };
    return this.resolve({ ...s, bettors: s.bettors.map((b) => ({ ...b, ready: true })) }, []);
  }

  pendingActors(s: BaccaratState): string[] {
    return s.phase === 'BETTING' ? s.bettors.filter((b) => !b.ready).map((b) => b.userId) : [];
  }

  timeoutSeconds(_s: BaccaratState, c: BaccaratConfig): number {
    return c.bettingSeconds;
  }

  view(s: BaccaratState): Record<string, unknown> {
    return {
      game: s.game,
      handNumber: s.handNumber,
      phase: s.phase,
      playerHand: s.playerHand,
      bankerHand: s.bankerHand,
      playerTotal: s.playerHand.length ? handTotal(s.playerHand) : null,
      bankerTotal: s.bankerHand.length ? handTotal(s.bankerHand) : null,
      outcome: s.outcome,
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

  isComplete(s: BaccaratState): boolean {
    return s.phase === 'COMPLETE';
  }

  results(s: BaccaratState): PlayerResult[] {
    return s.bettors.map((b) => {
      const delta = b.stack - b.startStack;
      return {
        userId: b.userId,
        delta,
        outcome: delta > 0 ? 'WIN' : delta < 0 ? 'LOSS' : 'DRAW',
        details: { bets: b.bets, outcome: s.outcome },
      };
    });
  }

  finalStacks(s: BaccaratState): Record<string, number> {
    return Object.fromEntries(s.bettors.map((b) => [b.userId, b.stack]));
  }
}
