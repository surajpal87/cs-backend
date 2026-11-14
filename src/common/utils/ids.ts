import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/** Public numeric id with a prefix, e.g. CS48210937. */
export function publicId(prefix: string, digits = 8): string {
  let s = String(randomInt(1, 10));
  for (let i = 1; i < digits; i++) s += String(randomInt(0, 10));
  return prefix + s;
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function roomCode(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ROOM_ALPHABET[randomInt(0, ROOM_ALPHABET.length)];
  return s;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hmac(secret: string, s: string): string {
  return createHmac('sha256', secret).update(s).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function otpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** ISO week key, e.g. 2026-W46 (UTC). */
export function isoWeekKey(d = new Date()): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Sorted pair key for undirected relations (friendships, direct chats). */
export function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
