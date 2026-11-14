import { Rng } from './rng';

export type GameCodeName = 'TEEN_PATTI' | 'POKER' | 'OMAHA' | 'RUMMY' | 'ANDAR_BAHAR' | 'BACCARAT' | 'GOLD_MINES';

export interface SeatedPlayer {
  userId: string;
  seat: number;
  name: string;
  /** Chips the player brings into this hand. */
  stack: number;
}

/**
 * Engine events drive client animations (deal, flip, chips-to-pot, ...).
 * `to` restricts delivery to specific users (e.g. private hole cards); omitted = broadcast.
 */
export interface EngineEvent {
  type: string;
  payload: Record<string, unknown>;
  to?: string[];
}

export interface StepResult<S> {
  state: S;
  events: EngineEvent[];
}

export interface PlayerAction {
  type: string;
  [key: string]: unknown;
}

export interface PlayerResult {
  userId: string;
  /** Net chip change for this hand (positive = won). */
  delta: number;
  outcome: 'WIN' | 'LOSS' | 'DRAW' | 'FOLD';
  rank?: number;
  details?: Record<string, unknown>;
}

export interface HandContext {
  handNumber: number;
  rng: Rng;
}

/** Thrown for any illegal move; message is safe to show to the player. */
export class GameRuleError extends Error {
  constructor(
    message: string,
    public readonly code = 'ILLEGAL_ACTION',
  ) {
    super(message);
  }
}

/**
 * Contract implemented independently by every game module.
 * Engines are pure: they never touch I/O, time or Math.random — the runtime injects RNG and
 * drives timeouts — so they are deterministic and unit-testable.
 */
export interface GameEngine<S = unknown, C = Record<string, unknown>> {
  readonly code: GameCodeName;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly defaultConfig: C;

  /** Merge + validate a room config. Throws GameRuleError on invalid values. */
  normalizeConfig(input: Partial<C> | undefined): C;
  /** Minimum stack a player needs to be dealt into a hand. */
  minStackToPlay(config: C): number;
  start(players: SeatedPlayer[], config: C, ctx: HandContext): StepResult<S>;
  act(state: S, userId: string, action: PlayerAction, rng: Rng): StepResult<S>;
  /** Called by the runtime when the turn/phase timer expires. */
  onTimeout(state: S, rng: Rng): StepResult<S>;
  /** Users the engine is currently waiting on (for timers / turn indicators). */
  pendingActors(state: S): string[];
  /** Seconds before onTimeout fires for the current phase. */
  timeoutSeconds(state: S, config: C): number;
  /** Redacted state for a viewer (null = spectator). Never leaks hidden cards. */
  view(state: S, viewerId: string | null): Record<string, unknown>;
  /** Legal actions for the user right now (drives the client action bar). */
  legalActions(state: S, userId: string): Record<string, unknown>[];
  isComplete(state: S): boolean;
  results(state: S): PlayerResult[];
  /** Final stacks after the hand (persisted by the runtime). */
  finalStacks(state: S): Record<string, number>;
}

export function assert(cond: unknown, message: string, code?: string): asserts cond {
  if (!cond) throw new GameRuleError(message, code);
}

export function intArg(action: PlayerAction, key: string): number {
  const v = action[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new GameRuleError(`"${key}" must be a non-negative integer`, 'BAD_ARGUMENT');
  }
  return v;
}
