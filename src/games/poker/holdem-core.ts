import { Card, createDeck, shuffle } from '../core/cards';
import {
  assert,
  EngineEvent,
  GameCodeName,
  GameEngine,
  GameRuleError,
  HandContext,
  intArg,
  PlayerAction,
  PlayerResult,
  SeatedPlayer,
  StepResult,
} from '../core/engine';
import { PokerHandValue } from './poker.hand';

/**
 * Community-card betting core shared by Texas Hold'em (No-Limit, 2 hole cards, best 5 of 7)
 * and Omaha (Pot-Limit, 4 hole cards, exactly 2 hole + 3 board). The variants plug in their
 * own hole-card count, hand evaluator and betting-limit structure.
 */
export interface HoldemVariant {
  code: GameCodeName;
  holeCards: number;
  limit: 'NO_LIMIT' | 'POT_LIMIT';
  maxPlayers: number;
  evaluate(hole: Card[], board: Card[]): PokerHandValue;
}

export interface HoldemConfig {
  smallBlind: number;
  bigBlind: number;
  turnSeconds: number;
}

export type Street = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'COMPLETE';

export interface HPlayer {
  userId: string;
  seat: number;
  name: string;
  startStack: number;
  stack: number;
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  /** Amount put in on the current street. */
  bet: number;
  /** Amount put in over the whole hand. */
  contributed: number;
  acted: boolean;
}

export interface PotResult {
  amount: number;
  eligible: string[];
  winners: string[];
}

export interface HoldemState {
  game: GameCodeName;
  handNumber: number;
  config: HoldemConfig;
  street: Street;
  players: HPlayer[];
  deck: Card[];
  board: Card[];
  dealerIndex: number;
  sbIndex: number;
  bbIndex: number;
  actorIndex: number;
  currentBet: number;
  minRaise: number;
  pots: PotResult[];
  winners: string[];
  showdown: { userId: string; cards: Card[]; hand: string; best: Card[] }[];
}

const DEFAULTS: HoldemConfig = { smallBlind: 5, bigBlind: 10, turnSeconds: 25 };

function clone(s: HoldemState): HoldemState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, hole: [...p.hole] })),
    deck: [...s.deck],
    board: [...s.board],
    pots: s.pots.map((p) => ({ ...p })),
    showdown: [...s.showdown],
  };
}

export class HoldemFamilyEngine implements GameEngine<HoldemState, HoldemConfig> {
  readonly code: GameCodeName;
  readonly minPlayers = 2;
  readonly maxPlayers: number;
  readonly defaultConfig = DEFAULTS;

  constructor(private readonly variant: HoldemVariant) {
    this.code = variant.code;
    this.maxPlayers = variant.maxPlayers;
  }

  normalizeConfig(input?: Partial<HoldemConfig>): HoldemConfig {
    const c = { ...DEFAULTS, ...(input ?? {}) };
    if (input?.bigBlind && !input.smallBlind) c.smallBlind = Math.max(1, Math.floor(c.bigBlind / 2));
    assert(Number.isInteger(c.smallBlind) && c.smallBlind >= 1, 'Small blind must be >= 1', 'BAD_CONFIG');
    assert(Number.isInteger(c.bigBlind) && c.bigBlind >= c.smallBlind, 'Big blind must be >= small blind', 'BAD_CONFIG');
    assert(c.turnSeconds >= 5 && c.turnSeconds <= 120, 'Turn time must be 5-120s', 'BAD_CONFIG');
    return c;
  }

  minStackToPlay(c: HoldemConfig): number {
    return c.bigBlind;
  }

  start(seated: SeatedPlayer[], config: HoldemConfig, ctx: HandContext): StepResult<HoldemState> {
    assert(seated.length >= 2 && seated.length <= this.maxPlayers, 'Invalid player count');
    const ordered = [...seated].sort((a, b) => a.seat - b.seat);
    const n = ordered.length;
    const dealerIndex = (ctx.handNumber - 1) % n;
    const headsUp = n === 2;
    const sbIndex = headsUp ? dealerIndex : (dealerIndex + 1) % n;
    const bbIndex = (sbIndex + 1) % n;

    const s: HoldemState = {
      game: this.variant.code,
      handNumber: ctx.handNumber,
      config,
      street: 'PREFLOP',
      players: ordered.map((p) => ({
        userId: p.userId,
        seat: p.seat,
        name: p.name,
        startStack: p.stack,
        stack: p.stack,
        hole: [],
        folded: false,
        allIn: false,
        bet: 0,
        contributed: 0,
        acted: false,
      })),
      deck: shuffle(createDeck(), ctx.rng),
      board: [],
      dealerIndex,
      sbIndex,
      bbIndex,
      actorIndex: -1,
      currentBet: config.bigBlind,
      minRaise: config.bigBlind,
      pots: [],
      winners: [],
      showdown: [],
    };
    const events: EngineEvent[] = [
      { type: 'HAND_STARTED', payload: { handNumber: ctx.handNumber, dealerSeat: s.players[dealerIndex].seat } },
    ];
    const sb = this.commit(s, s.players[sbIndex], config.smallBlind);
    const bb = this.commit(s, s.players[bbIndex], config.bigBlind);
    events.push({
      type: 'BLINDS_POSTED',
      payload: {
        smallBlind: { userId: s.players[sbIndex].userId, amount: sb },
        bigBlind: { userId: s.players[bbIndex].userId, amount: bb },
      },
    });

    const order: number[] = [];
    for (let i = 0; i < n; i++) order.push((sbIndex + i) % n);
    for (let r = 0; r < this.variant.holeCards; r++) for (const i of order) s.players[i].hole.push(s.deck.pop()!);
    events.push({
      type: 'CARDS_DEALT',
      payload: { seats: order.map((i) => s.players[i].seat), cardsEach: this.variant.holeCards, faceDown: true },
    });
    for (const p of s.players) events.push({ type: 'HOLE_CARDS', payload: { cards: p.hole }, to: [p.userId] });

    s.actorIndex = this.nextToAct(s, bbIndex);
    if (s.actorIndex < 0) return this.closeStreet(s, events);
    events.push({ type: 'TURN', payload: { userId: s.players[s.actorIndex].userId } });
    return { state: s, events };
  }

  /** Moves chips from stack to the street bet, capping at the stack (all-in). Returns amount moved. */
  private commit(s: HoldemState, p: HPlayer, amount: number): number {
    const amt = Math.min(amount, p.stack);
    p.stack -= amt;
    p.bet += amt;
    p.contributed += amt;
    if (p.stack === 0) p.allIn = true;
    return amt;
  }

  private canAct(p: HPlayer): boolean {
    return !p.folded && !p.allIn;
  }

  private nextToAct(s: HoldemState, from: number): number {
    const n = s.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      const p = s.players[idx];
      if (this.canAct(p) && (!p.acted || p.bet < s.currentBet)) return idx;
    }
    return -1;
  }

  private potTotal(s: HoldemState): number {
    return s.players.reduce((t, p) => t + p.contributed, 0);
  }

  private maxRaiseTo(s: HoldemState, p: HPlayer): number {
    const allInTo = p.bet + p.stack;
    if (this.variant.limit === 'NO_LIMIT') return allInTo;
    const toCall = s.currentBet - p.bet;
    // Pot-limit: call first, then raise by the size of the pot.
    const potAfterCall = this.potTotal(s) + toCall;
    return Math.min(allInTo, s.currentBet + potAfterCall);
  }

  legalActions(s: HoldemState, userId: string): Record<string, unknown>[] {
    if (s.street === 'COMPLETE' || s.actorIndex < 0) return [];
    const p = s.players[s.actorIndex];
    if (p.userId !== userId) return [];
    const toCall = s.currentBet - p.bet;
    const out: Record<string, unknown>[] = [{ type: 'fold' }];
    if (toCall <= 0) out.push({ type: 'check' });
    else out.push({ type: 'call', amount: Math.min(toCall, p.stack) });
    const minTo = s.currentBet + s.minRaise;
    const maxTo = this.maxRaiseTo(s, p);
    if (p.stack > toCall) {
      if (maxTo >= minTo) out.push({ type: s.currentBet === 0 ? 'bet' : 'raise', min: minTo, max: maxTo });
      if (this.variant.limit === 'NO_LIMIT' || maxTo === p.bet + p.stack) out.push({ type: 'allin', amount: p.bet + p.stack });
    }
    return out;
  }

  act(input: HoldemState, userId: string, action: PlayerAction): StepResult<HoldemState> {
    assert(input.street !== 'COMPLETE', 'Hand is over', 'HAND_OVER');
    const s = clone(input);
    const p = s.players[s.actorIndex];
    assert(p && p.userId === userId, 'It is not your turn', 'NOT_YOUR_TURN');
    const events: EngineEvent[] = [];
    const toCall = s.currentBet - p.bet;

    switch (action.type) {
      case 'fold':
        p.folded = true;
        events.push({ type: 'PLAYER_FOLDED', payload: { userId } });
        break;
      case 'check':
        assert(toCall <= 0, 'You cannot check facing a bet');
        events.push({ type: 'PLAYER_CHECKED', payload: { userId } });
        break;
      case 'call': {
        assert(toCall > 0, 'Nothing to call; check instead');
        const amt = this.commit(s, p, toCall);
        events.push({ type: 'BET', payload: { userId, action: p.allIn ? 'allin' : 'call', amount: amt, total: p.bet } });
        break;
      }
      case 'bet':
      case 'raise':
      case 'allin': {
        const allInTo = p.bet + p.stack;
        const raiseTo = action.type === 'allin' ? allInTo : intArg(action, 'amount');
        assert(raiseTo <= allInTo, 'Not enough chips', 'INSUFFICIENT_CHIPS');
        if (action.type === 'allin' && raiseTo <= s.currentBet) {
          // All-in for less than (or equal to) a call.
          const amt = this.commit(s, p, p.stack);
          events.push({ type: 'BET', payload: { userId, action: 'allin', amount: amt, total: p.bet } });
          break;
        }
        assert(raiseTo > s.currentBet, 'Raise must exceed the current bet');
        assert(raiseTo <= this.maxRaiseTo(s, p), 'Raise exceeds the pot limit', 'OVER_LIMIT');
        const increment = raiseTo - s.currentBet;
        const isAllIn = raiseTo === allInTo;
        assert(increment >= s.minRaise || isAllIn, `Minimum raise is to ${s.currentBet + s.minRaise}`, 'MIN_RAISE');
        const amt = this.commit(s, p, raiseTo - p.bet);
        if (increment >= s.minRaise) {
          s.minRaise = increment;
          // A full raise re-opens the action for everyone else.
          for (const o of s.players) if (o !== p && this.canAct(o)) o.acted = false;
        }
        s.currentBet = raiseTo;
        events.push({
          type: 'BET',
          payload: {
            userId,
            action: isAllIn ? 'allin' : s.street === 'PREFLOP' || toCall > 0 ? 'raise' : 'bet',
            amount: amt,
            total: p.bet,
          },
        });
        break;
      }
      default:
        throw new GameRuleError(`Unknown action "${action.type}"`, 'UNKNOWN_ACTION');
    }
    p.acted = true;
    if (events.some((e) => e.type === 'BET')) {
      events.push({
        type: 'CHIPS_TO_POT',
        payload: { from: [userId], amount: events.find((e) => e.type === 'BET')!.payload.amount as number },
      });
    }

    const live = s.players.filter((x) => !x.folded);
    if (live.length === 1) return this.awardUncontested(s, live[0], events);

    const next = this.nextToAct(s, s.actorIndex);
    if (next >= 0) {
      s.actorIndex = next;
      events.push({ type: 'TURN', payload: { userId: s.players[next].userId } });
      return { state: s, events };
    }
    return this.closeStreet(s, events);
  }

  private closeStreet(s: HoldemState, events: EngineEvent[]): StepResult<HoldemState> {
    for (const p of s.players) {
      p.bet = 0;
      p.acted = false;
    }
    s.currentBet = 0;
    s.minRaise = s.config.bigBlind;
    events.push({ type: 'BETS_TO_POT', payload: { pot: this.potTotal(s) } });

    const canStillBet = s.players.filter((p) => this.canAct(p)).length;
    while (true) {
      if (s.street === 'RIVER') return this.showdown(s, events);
      this.dealNextStreet(s, events);
      if (canStillBet >= 2) {
        s.actorIndex = this.nextToAct(s, s.dealerIndex);
        if (s.actorIndex >= 0) {
          events.push({ type: 'TURN', payload: { userId: s.players[s.actorIndex].userId } });
          return { state: s, events };
        }
      }
      // Fewer than two players can bet: run the board out.
    }
  }

  private dealNextStreet(s: HoldemState, events: EngineEvent[]) {
    s.deck.pop(); // burn
    const count = s.street === 'PREFLOP' ? 3 : 1;
    const cards: Card[] = [];
    for (let i = 0; i < count; i++) cards.push(s.deck.pop()!);
    s.board.push(...cards);
    s.street = s.street === 'PREFLOP' ? 'FLOP' : s.street === 'FLOP' ? 'TURN' : 'RIVER';
    events.push({ type: 'BOARD_DEALT', payload: { street: s.street, cards, board: s.board } });
  }

  private awardUncontested(s: HoldemState, winner: HPlayer, events: EngineEvent[]): StepResult<HoldemState> {
    const total = this.potTotal(s);
    winner.stack += total;
    s.street = 'COMPLETE';
    s.actorIndex = -1;
    s.winners = [winner.userId];
    s.pots = [{ amount: total, eligible: [winner.userId], winners: [winner.userId] }];
    events.push({ type: 'POT_TO_WINNER', payload: { winners: [winner.userId], amount: total, potIndex: 0 } });
    events.push({ type: 'HAND_COMPLETE', payload: { winners: s.winners, pots: s.pots, reason: 'uncontested' } });
    return { state: s, events };
  }

  private showdown(s: HoldemState, events: EngineEvent[]): StepResult<HoldemState> {
    const live = s.players.filter((p) => !p.folded);
    const values = new Map(live.map((p) => [p.userId, this.variant.evaluate(p.hole, s.board)]));
    s.showdown = live.map((p) => ({
      userId: p.userId,
      cards: p.hole,
      hand: values.get(p.userId)!.name,
      best: values.get(p.userId)!.cards,
    }));
    events.push({ type: 'SHOWDOWN', payload: { hands: s.showdown, board: s.board } });

    // Side pots: layer contributions by each live player's all-in level.
    const levels = [...new Set(live.map((p) => p.contributed))].sort((a, b) => a - b);
    let prev = 0;
    const pots: PotResult[] = [];
    for (const level of levels) {
      let amount = 0;
      for (const p of s.players) amount += Math.max(0, Math.min(p.contributed, level) - prev);
      const eligible = live.filter((p) => p.contributed >= level).map((p) => p.userId);
      if (amount > 0) pots.push({ amount, eligible, winners: [] });
      prev = level;
    }
    // Folded players' chips above the highest live level are dead money -> last pot.
    const overflow = s.players.reduce((t, p) => t + Math.max(0, p.contributed - prev), 0);
    if (overflow && pots.length) pots[pots.length - 1].amount += overflow;

    const n = s.players.length;
    const seatOrder = (id: string) => (s.players.findIndex((p) => p.userId === id) - s.dealerIndex - 1 + n) % n;
    const allWinners = new Set<string>();
    pots.forEach((pot, i) => {
      const top = Math.max(...pot.eligible.map((id) => values.get(id)!.score));
      pot.winners = pot.eligible.filter((id) => values.get(id)!.score === top).sort((a, b) => seatOrder(a) - seatOrder(b));
      const share = Math.floor(pot.amount / pot.winners.length);
      let odd = pot.amount - share * pot.winners.length;
      for (const id of pot.winners) {
        const w = s.players.find((p) => p.userId === id)!;
        w.stack += share + (odd-- > 0 ? 1 : 0);
        allWinners.add(id);
      }
      events.push({ type: 'POT_TO_WINNER', payload: { winners: pot.winners, amount: pot.amount, potIndex: i } });
    });
    s.pots = pots;
    s.winners = [...allWinners];
    s.street = 'COMPLETE';
    s.actorIndex = -1;
    events.push({ type: 'HAND_COMPLETE', payload: { winners: s.winners, pots, reason: 'showdown' } });
    return { state: s, events };
  }

  onTimeout(s: HoldemState): StepResult<HoldemState> {
    if (s.street === 'COMPLETE' || s.actorIndex < 0) return { state: s, events: [] };
    const p = s.players[s.actorIndex];
    const r = this.act(s, p.userId, { type: p.bet >= s.currentBet ? 'check' : 'fold' });
    r.events.unshift({ type: 'TIMEOUT', payload: { userId: p.userId } });
    return r;
  }

  pendingActors(s: HoldemState): string[] {
    return s.street === 'COMPLETE' || s.actorIndex < 0 ? [] : [s.players[s.actorIndex].userId];
  }

  timeoutSeconds(_s: HoldemState, c: HoldemConfig): number {
    return c.turnSeconds;
  }

  view(s: HoldemState, viewerId: string | null): Record<string, unknown> {
    const shown = new Map(s.showdown.map((x) => [x.userId, x]));
    return {
      game: s.game,
      handNumber: s.handNumber,
      street: s.street,
      board: s.board,
      pot: this.potTotal(s),
      currentBet: s.currentBet,
      minRaise: s.minRaise,
      smallBlind: s.config.smallBlind,
      bigBlind: s.config.bigBlind,
      dealerSeat: s.players[s.dealerIndex].seat,
      turnUserId: s.actorIndex >= 0 ? s.players[s.actorIndex].userId : null,
      pots: s.pots,
      winners: s.winners,
      players: s.players.map((p) => {
        const visible = p.userId === viewerId || shown.has(p.userId);
        return {
          userId: p.userId,
          seat: p.seat,
          name: p.name,
          stack: p.stack,
          bet: p.bet,
          contributed: p.contributed,
          folded: p.folded,
          allIn: p.allIn,
          cardCount: p.hole.length,
          cards: visible ? p.hole : null,
          hand: shown.get(p.userId)?.hand ?? null,
          best: shown.get(p.userId)?.best ?? null,
        };
      }),
    };
  }

  isComplete(s: HoldemState): boolean {
    return s.street === 'COMPLETE';
  }

  results(s: HoldemState): PlayerResult[] {
    return s.players.map((p) => {
      const delta = p.stack - p.startStack;
      const won = s.winners.includes(p.userId);
      return {
        userId: p.userId,
        delta,
        outcome: p.folded ? 'FOLD' : won ? (delta >= 0 ? 'WIN' : 'DRAW') : 'LOSS',
        rank: won ? 1 : 2,
        details: { hand: s.showdown.find((x) => x.userId === p.userId)?.hand ?? null, board: s.board },
      };
    });
  }

  finalStacks(s: HoldemState): Record<string, number> {
    return Object.fromEntries(s.players.map((p) => [p.userId, p.stack]));
  }
}
