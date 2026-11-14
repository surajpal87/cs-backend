import { Card, createDeck, shuffle } from '../core/cards';
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
import { compareTeenPatti, evaluateTeenPatti, TpHandValue } from './teen-patti.hand';

export interface TeenPattiConfig {
  boot: number;
  /** Highest allowed blind stake (chaal value for a blind player). */
  maxStake: number;
  /** When the pot reaches this, all active players are forced to a show. */
  potLimit: number;
  turnSeconds: number;
}

export interface TpPlayer {
  userId: string;
  seat: number;
  name: string;
  startStack: number;
  stack: number;
  cards: Card[];
  seen: boolean;
  folded: boolean;
  invested: number;
}

export type TpPhase = 'BETTING' | 'SIDESHOW' | 'COMPLETE';
export type TpEndReason = 'LAST_STANDING' | 'SHOW' | 'POT_LIMIT';

export interface TeenPattiState {
  game: 'TEEN_PATTI';
  handNumber: number;
  config: TeenPattiConfig;
  phase: TpPhase;
  players: TpPlayer[];
  dealerIndex: number;
  turnIndex: number;
  pot: number;
  /** Current blind stake; seen players pay double. */
  stake: number;
  sideshow: { requester: string; target: string } | null;
  winners: string[];
  endReason: TpEndReason | null;
  /** Hands revealed at a show (or pot-limit showdown). */
  revealed: { userId: string; cards: Card[]; hand: string }[];
  actionCount: number;
}

const DEFAULTS: TeenPattiConfig = { boot: 10, maxStake: 1280, potLimit: 10240, turnSeconds: 20 };

function clone(s: TeenPattiState): TeenPattiState {
  return { ...s, players: s.players.map((p) => ({ ...p, cards: [...p.cards] })), revealed: [...s.revealed] };
}

function active(s: TeenPattiState): TpPlayer[] {
  return s.players.filter((p) => !p.folded);
}

function nextActiveIndex(s: TeenPattiState, from: number): number {
  const n = s.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (!s.players[idx].folded) return idx;
  }
  return from;
}

function prevActiveIndex(s: TeenPattiState, from: number): number {
  const n = s.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from - i + n) % n;
    if (!s.players[idx].folded) return idx;
  }
  return from;
}

function handOf(p: TpPlayer): TpHandValue {
  return evaluateTeenPatti(p.cards);
}

export class TeenPattiEngine implements GameEngine<TeenPattiState, TeenPattiConfig> {
  readonly code = 'TEEN_PATTI' as const;
  readonly minPlayers = 2;
  readonly maxPlayers = 6;
  readonly defaultConfig = DEFAULTS;

  normalizeConfig(input?: Partial<TeenPattiConfig>): TeenPattiConfig {
    const c = { ...DEFAULTS, ...(input ?? {}) };
    assert(Number.isInteger(c.boot) && c.boot >= 1, 'Boot must be a positive integer', 'BAD_CONFIG');
    if (!input?.maxStake) c.maxStake = c.boot * 128;
    if (!input?.potLimit) c.potLimit = c.boot * 1024;
    assert(c.maxStake >= c.boot * 2, 'Max stake must be at least 2x boot', 'BAD_CONFIG');
    assert(c.potLimit >= c.boot * 10, 'Pot limit must be at least 10x boot', 'BAD_CONFIG');
    assert(c.turnSeconds >= 5 && c.turnSeconds <= 120, 'Turn time must be 5-120s', 'BAD_CONFIG');
    return c;
  }

  minStackToPlay(config: TeenPattiConfig): number {
    return config.boot * 2;
  }

  start(seated: SeatedPlayer[], config: TeenPattiConfig, ctx: HandContext): StepResult<TeenPattiState> {
    assert(seated.length >= this.minPlayers, 'Need at least 2 players');
    assert(seated.length <= this.maxPlayers, 'Too many players');
    const ordered = [...seated].sort((a, b) => a.seat - b.seat);
    const deck = shuffle(createDeck(), ctx.rng);
    const dealerIndex = (ctx.handNumber - 1) % ordered.length;

    const players: TpPlayer[] = ordered.map((p) => {
      assert(p.stack >= config.boot, `${p.name} cannot cover the boot`);
      return {
        userId: p.userId,
        seat: p.seat,
        name: p.name,
        startStack: p.stack,
        stack: p.stack - config.boot,
        cards: [],
        seen: false,
        folded: false,
        invested: config.boot,
      };
    });
    // Deal one card at a time, starting left of the dealer.
    const order: number[] = [];
    for (let i = 1; i <= players.length; i++) order.push((dealerIndex + i) % players.length);
    for (let round = 0; round < 3; round++) for (const idx of order) players[idx].cards.push(deck.pop()!);

    const state: TeenPattiState = {
      game: 'TEEN_PATTI',
      handNumber: ctx.handNumber,
      config,
      phase: 'BETTING',
      players,
      dealerIndex,
      turnIndex: (dealerIndex + 1) % players.length,
      pot: config.boot * players.length,
      stake: config.boot,
      sideshow: null,
      winners: [],
      endReason: null,
      revealed: [],
      actionCount: 0,
    };
    const events: EngineEvent[] = [
      { type: 'HAND_STARTED', payload: { handNumber: ctx.handNumber, dealerSeat: players[dealerIndex].seat } },
      { type: 'CHIPS_TO_POT', payload: { from: players.map((p) => p.userId), amount: config.boot, pot: state.pot, reason: 'boot' } },
      { type: 'CARDS_DEALT', payload: { seats: order.map((i) => players[i].seat), cardsEach: 3, faceDown: true } },
      { type: 'TURN', payload: { userId: players[state.turnIndex].userId } },
    ];
    return { state, events };
  }

  private chaalAmount(s: TeenPattiState, p: TpPlayer): number {
    return p.seen ? s.stake * 2 : s.stake;
  }

  private canRaise(s: TeenPattiState): boolean {
    return s.stake * 2 <= s.config.maxStake;
  }

  legalActions(s: TeenPattiState, userId: string): Record<string, unknown>[] {
    const idx = s.players.findIndex((p) => p.userId === userId);
    if (idx < 0 || s.phase === 'COMPLETE') return [];
    const p = s.players[idx];
    if (p.folded) return [];
    const out: Record<string, unknown>[] = [];
    if (!p.seen) out.push({ type: 'see' });
    if (s.phase === 'SIDESHOW') {
      if (s.sideshow?.target === userId) out.push({ type: 'sideshow_accept' }, { type: 'sideshow_decline' });
      return out;
    }
    if (s.turnIndex !== idx) return out;
    const chaal = this.chaalAmount(s, p);
    out.push({ type: 'pack' });
    if (p.stack >= chaal) out.push({ type: 'chaal', amount: chaal });
    if (this.canRaise(s) && p.stack >= chaal * 2) out.push({ type: 'raise', amount: chaal * 2 });
    const live = active(s);
    if (live.length === 2 && p.stack >= chaal) out.push({ type: 'show', amount: chaal });
    if (live.length > 2 && p.seen && p.stack >= chaal) {
      const prev = s.players[prevActiveIndex(s, idx)];
      if (prev.seen) out.push({ type: 'sideshow', amount: chaal, target: prev.userId });
    }
    return out;
  }

  act(input: TeenPattiState, userId: string, action: PlayerAction): StepResult<TeenPattiState> {
    assert(input.phase !== 'COMPLETE', 'Hand is over', 'HAND_OVER');
    const s = clone(input);
    const idx = s.players.findIndex((p) => p.userId === userId);
    assert(idx >= 0, 'You are not in this hand', 'NOT_IN_HAND');
    const p = s.players[idx];
    assert(!p.folded, 'You have already packed', 'FOLDED');
    const events: EngineEvent[] = [];
    s.actionCount++;

    if (action.type === 'see') {
      assert(!p.seen, 'Cards already seen');
      p.seen = true;
      events.push({ type: 'PLAYER_SEEN', payload: { userId } });
      events.push({ type: 'CARDS_REVEALED_PRIVATE', payload: { userId, cards: p.cards, hand: handOf(p).name }, to: [userId] });
      return { state: s, events };
    }

    if (s.phase === 'SIDESHOW') {
      assert(s.sideshow && s.sideshow.target === userId, 'Waiting for a side show response', 'NOT_YOUR_TURN');
      return this.resolveSideshow(s, action.type === 'sideshow_accept', events);
    }

    assert(s.turnIndex === idx, 'It is not your turn', 'NOT_YOUR_TURN');
    const chaal = this.chaalAmount(s, p);

    switch (action.type) {
      case 'pack': {
        p.folded = true;
        events.push({ type: 'PLAYER_PACKED', payload: { userId } });
        return this.afterTurn(s, idx, events);
      }
      case 'chaal':
      case 'raise': {
        const raise = action.type === 'raise';
        if (raise) assert(this.canRaise(s), 'Stake is already at the maximum');
        const amount = raise ? chaal * 2 : chaal;
        assert(p.stack >= amount, 'Not enough chips', 'INSUFFICIENT_CHIPS');
        if (raise) s.stake *= 2;
        this.pay(s, p, amount);
        events.push({ type: 'BET', payload: { userId, action: action.type, amount, blind: !p.seen, stake: s.stake, pot: s.pot } });
        events.push({ type: 'CHIPS_TO_POT', payload: { from: [userId], amount, pot: s.pot } });
        if (s.pot >= s.config.potLimit) return this.showdown(s, active(s), 'POT_LIMIT', events);
        return this.afterTurn(s, idx, events);
      }
      case 'show': {
        const live = active(s);
        assert(live.length === 2, 'Show is only allowed when two players remain');
        assert(p.stack >= chaal, 'Not enough chips', 'INSUFFICIENT_CHIPS');
        this.pay(s, p, chaal);
        events.push({ type: 'BET', payload: { userId, action: 'show', amount: chaal, pot: s.pot } });
        events.push({ type: 'CHIPS_TO_POT', payload: { from: [userId], amount: chaal, pot: s.pot } });
        const other = live.find((x) => x.userId !== userId)!;
        // On an exact tie the player who asked for the show loses.
        const cmp = compareTeenPatti(handOf(p), handOf(other));
        const winner = cmp > 0 ? p : other;
        return this.finish(s, [winner], 'SHOW', [p, other], events);
      }
      case 'sideshow': {
        const live = active(s);
        assert(live.length > 2, 'Side show needs at least three active players');
        assert(p.seen, 'Only a seen player can ask for a side show');
        const prev = s.players[prevActiveIndex(s, idx)];
        assert(prev.seen, 'The previous player is blind; side show not allowed');
        assert(p.stack >= chaal, 'Not enough chips', 'INSUFFICIENT_CHIPS');
        this.pay(s, p, chaal);
        s.phase = 'SIDESHOW';
        s.sideshow = { requester: userId, target: prev.userId };
        events.push({ type: 'CHIPS_TO_POT', payload: { from: [userId], amount: chaal, pot: s.pot } });
        events.push({ type: 'SIDESHOW_REQUESTED', payload: { from: userId, to: prev.userId } });
        return { state: s, events };
      }
      default:
        throw new GameRuleError(`Unknown action "${action.type}"`, 'UNKNOWN_ACTION');
    }
  }

  private pay(s: TeenPattiState, p: TpPlayer, amount: number) {
    p.stack -= amount;
    p.invested += amount;
    s.pot += amount;
  }

  private resolveSideshow(s: TeenPattiState, accepted: boolean, events: EngineEvent[]): StepResult<TeenPattiState> {
    const { requester, target } = s.sideshow!;
    const reqIdx = s.players.findIndex((p) => p.userId === requester);
    const req = s.players[reqIdx];
    const tgt = s.players.find((p) => p.userId === target)!;
    s.phase = 'BETTING';
    s.sideshow = null;
    if (!accepted) {
      events.push({ type: 'SIDESHOW_DECLINED', payload: { from: requester, to: target } });
      return this.afterTurn(s, reqIdx, events);
    }
    const cmp = compareTeenPatti(handOf(req), handOf(tgt));
    const loser = cmp > 0 ? tgt : req; // tie -> requester packs
    loser.folded = true;
    events.push({
      type: 'SIDESHOW_RESULT',
      payload: { from: requester, to: target, loser: loser.userId },
    });
    // Both players privately see each other's cards.
    events.push({ type: 'SIDESHOW_CARDS', payload: { userId: target, cards: tgt.cards }, to: [requester] });
    events.push({ type: 'SIDESHOW_CARDS', payload: { userId: requester, cards: req.cards }, to: [target] });
    events.push({ type: 'PLAYER_PACKED', payload: { userId: loser.userId, reason: 'sideshow' } });
    return this.afterTurn(s, reqIdx, events);
  }

  private afterTurn(s: TeenPattiState, fromIdx: number, events: EngineEvent[]): StepResult<TeenPattiState> {
    const live = active(s);
    if (live.length === 1) return this.finish(s, live, 'LAST_STANDING', [], events);
    s.turnIndex = nextActiveIndex(s, fromIdx);
    events.push({ type: 'TURN', payload: { userId: s.players[s.turnIndex].userId } });
    return { state: s, events };
  }

  private showdown(s: TeenPattiState, contenders: TpPlayer[], reason: TpEndReason, events: EngineEvent[]) {
    let best: TpPlayer[] = [];
    for (const p of contenders) {
      if (!best.length) best = [p];
      else {
        const c = compareTeenPatti(handOf(p), handOf(best[0]));
        if (c > 0) best = [p];
        else if (c === 0) best.push(p);
      }
    }
    return this.finish(s, best, reason, contenders, events);
  }

  private finish(
    s: TeenPattiState,
    winners: TpPlayer[],
    reason: TpEndReason,
    reveal: TpPlayer[],
    events: EngineEvent[],
  ): StepResult<TeenPattiState> {
    s.phase = 'COMPLETE';
    s.endReason = reason;
    s.winners = winners.map((w) => w.userId);
    s.revealed = reveal.map((p) => ({ userId: p.userId, cards: p.cards, hand: handOf(p).name }));
    const share = Math.floor(s.pot / winners.length);
    let remainder = s.pot - share * winners.length;
    for (const w of winners) {
      w.stack += share + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
    }
    if (s.revealed.length) events.push({ type: 'SHOWDOWN', payload: { hands: s.revealed } });
    events.push({
      type: 'HAND_COMPLETE',
      payload: { winners: s.winners, pot: s.pot, reason, amountEach: share },
    });
    events.push({ type: 'POT_TO_WINNER', payload: { winners: s.winners, amount: s.pot } });
    return { state: s, events };
  }

  onTimeout(s: TeenPattiState): StepResult<TeenPattiState> {
    if (s.phase === 'COMPLETE') return { state: s, events: [] };
    if (s.phase === 'SIDESHOW') return this.act(s, s.sideshow!.target, { type: 'sideshow_decline' });
    const uid = s.players[s.turnIndex].userId;
    const r = this.act(s, uid, { type: 'pack' });
    r.events.unshift({ type: 'TIMEOUT', payload: { userId: uid } });
    return r;
  }

  pendingActors(s: TeenPattiState): string[] {
    if (s.phase === 'COMPLETE') return [];
    if (s.phase === 'SIDESHOW') return [s.sideshow!.target];
    return [s.players[s.turnIndex].userId];
  }

  timeoutSeconds(_s: TeenPattiState, c: TeenPattiConfig): number {
    return c.turnSeconds;
  }

  view(s: TeenPattiState, viewerId: string | null): Record<string, unknown> {
    const revealed = new Map(s.revealed.map((r) => [r.userId, r]));
    return {
      game: s.game,
      handNumber: s.handNumber,
      phase: s.phase,
      pot: s.pot,
      stake: s.stake,
      boot: s.config.boot,
      potLimit: s.config.potLimit,
      dealerSeat: s.players[s.dealerIndex].seat,
      turnUserId: s.phase === 'COMPLETE' ? null : s.players[s.turnIndex].userId,
      sideshow: s.sideshow,
      winners: s.winners,
      endReason: s.endReason,
      players: s.players.map((p) => {
        const mine = p.userId === viewerId;
        const showCards = (mine && p.seen) || revealed.has(p.userId);
        return {
          userId: p.userId,
          seat: p.seat,
          name: p.name,
          stack: p.stack,
          invested: p.invested,
          seen: p.seen,
          folded: p.folded,
          cardCount: p.cards.length,
          cards: showCards ? p.cards : null,
          hand: showCards ? handOf(p).name : null,
        };
      }),
    };
  }

  isComplete(s: TeenPattiState): boolean {
    return s.phase === 'COMPLETE';
  }

  results(s: TeenPattiState): PlayerResult[] {
    return s.players.map((p) => {
      const won = s.winners.includes(p.userId);
      return {
        userId: p.userId,
        delta: p.stack - p.startStack,
        outcome: won ? (s.winners.length > 1 ? 'DRAW' : 'WIN') : p.folded ? 'FOLD' : 'LOSS',
        rank: won ? 1 : 2,
        details: { hand: s.revealed.find((r) => r.userId === p.userId)?.hand ?? null, seen: p.seen },
      };
    });
  }

  finalStacks(s: TeenPattiState): Record<string, number> {
    return Object.fromEntries(s.players.map((p) => [p.userId, p.stack]));
  }
}
