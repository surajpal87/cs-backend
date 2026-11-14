import { HoldemFamilyEngine } from './holdem-core';
import { evaluateHoldem } from './poker.hand';

/** No-Limit Texas Hold'em: 2 hole cards, best five of seven, 2-9 players. */
export class PokerEngine extends HoldemFamilyEngine {
  constructor() {
    super({ code: 'POKER', holeCards: 2, limit: 'NO_LIMIT', maxPlayers: 9, evaluate: evaluateHoldem });
  }
}
