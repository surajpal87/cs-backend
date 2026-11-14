import { createHash, createHmac, randomBytes } from 'crypto';

export interface Rng {
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

/**
 * Deterministic, cryptographically strong RNG: HMAC-SHA256(seed, counter) stream with
 * rejection sampling (no modulo bias). The server generates a random seed per hand,
 * publishes sha256(seed) as a commitment when the hand starts and reveals the seed when
 * it ends, so any player can re-verify the shuffle.
 */
export class SeededRng implements Rng {
  private counter = 0;
  private buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(private readonly seedHex: string) {
    if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new Error('Seed must be 32 bytes hex');
  }

  static fresh(): SeededRng {
    return new SeededRng(randomBytes(32).toString('hex'));
  }

  get seed(): string {
    return this.seedHex;
  }

  get commitment(): string {
    return createHash('sha256').update(this.seedHex, 'hex').digest('hex');
  }

  private nextUint32(): number {
    if (this.offset + 4 > this.buffer.length) {
      this.buffer = createHmac('sha256', Buffer.from(this.seedHex, 'hex')).update(String(this.counter++)).digest();
      this.offset = 0;
    }
    const v = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error('maxExclusive must be > 0');
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    let v: number;
    do v = this.nextUint32();
    while (v >= limit);
    return v % maxExclusive;
  }
}

/** Test helper: returns a predetermined sequence (mod max). */
export class SequenceRng implements Rng {
  private i = 0;
  constructor(private readonly values: number[]) {}
  int(maxExclusive: number): number {
    const v = this.values[this.i++ % this.values.length];
    return v % maxExclusive;
  }
}
