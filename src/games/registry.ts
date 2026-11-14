import { AndarBaharEngine } from './andar-bahar/andar-bahar.engine';
import { BaccaratEngine } from './baccarat/baccarat.engine';
import { GameCodeName, GameEngine } from './core/engine';
import { GoldMinesEngine } from './gold-mines/gold-mines.engine';
import { OmahaEngine } from './omaha/omaha.engine';
import { PokerEngine } from './poker/poker.engine';
import { RummyEngine } from './rummy/rummy.engine';
import { TeenPattiEngine } from './teen-patti/teen-patti.engine';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEngine = GameEngine<any, any>;

const ENGINES: Record<GameCodeName, AnyEngine> = {
  TEEN_PATTI: new TeenPattiEngine(),
  POKER: new PokerEngine(),
  OMAHA: new OmahaEngine(),
  RUMMY: new RummyEngine(),
  ANDAR_BAHAR: new AndarBaharEngine(),
  BACCARAT: new BaccaratEngine(),
  GOLD_MINES: new GoldMinesEngine(),
};

export function getEngine(code: GameCodeName): AnyEngine {
  const e = ENGINES[code];
  if (!e) throw new Error(`No engine for game ${code}`);
  return e;
}

export const GAME_CODES = Object.keys(ENGINES) as GameCodeName[];
