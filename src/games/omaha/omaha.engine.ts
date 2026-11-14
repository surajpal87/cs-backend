import { HoldemFamilyEngine } from '../poker/holdem-core';
import { evaluateOmaha } from '../poker/poker.hand';

/**
 * Pot-Limit Omaha: 4 hole cards; a hand must use exactly two hole cards and exactly
 * three board cards; raises are capped at the size of the pot. 2-6 players.
 */
export class OmahaEngine extends HoldemFamilyEngine {
  constructor() {
    super({ code: 'OMAHA', holeCards: 4, limit: 'POT_LIMIT', maxPlayers: 6, evaluate: evaluateOmaha });
  }
}
