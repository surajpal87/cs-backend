import { INestApplication } from '@nestjs/common';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { MailService } from '../src/common/mail/mail.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { createApp } from '../src/main';

/**
 * Full-stack test against a real MySQL test database (cs_card_station_test):
 * auth + OTP, friends, chat, associations, and a complete multiplayer Teen Patti hand played
 * by three Socket.IO clients, followed by settlement/ledger/leaderboard checks and admin RBAC.
 */
jest.setTimeout(180_000);

const otps = new Map<string, string>();
let app: INestApplication;
let prisma: PrismaService;
let baseUrl: string;
const tag = Date.now().toString(36);

interface Player {
  id: string;
  token: string;
  refresh: string;
  email: string;
  socket?: Socket;
}

const http = () => request(app.getHttpServer());
const auth = (p: Player) => ({ Authorization: `Bearer ${p.token}` });

async function registerAndVerify(name: string): Promise<Player> {
  const email = `${name}_${tag}@test.local`;
  const r = await http()
    .post('/api/v1/auth/register')
    .send({ email, username: `${name}_${tag}`.slice(0, 20), password: 'Passw0rd!x' })
    .expect(201);
  expect(r.body.otpRequired).toBe(true);
  const code = otps.get(email)!;
  expect(code).toMatch(/^\d{6}$/);
  const bad = await http()
    .post('/api/v1/auth/verify-otp')
    .send({ email, code: code === '000000' ? '111111' : '000000' });
  expect(bad.status).toBe(400);
  const v = await http().post('/api/v1/auth/verify-otp').send({ email, code }).expect(200);
  return { id: v.body.user.id, token: v.body.accessToken, refresh: v.body.refreshToken, email };
}

function connect(p: Player): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(baseUrl, { auth: { token: p.token }, transports: ['websocket'], forceNew: true });
    s.on('session:ready', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function emit<T = any>(s: Socket, event: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    s.timeout(10_000).emit(event, body, (err: unknown, ack: { ok: boolean; data?: T; error?: { message: string } }) => {
      if (err) return reject(err);
      if (!ack.ok) return reject(new Error(`${event}: ${ack.error?.message}`));
      resolve(ack.data as T);
    });
  });
}

beforeAll(async () => {
  const cwd = __dirname + '/..';
  if (process.env.ADMIN_DATABASE_URL) {
    // Create the test database next to the development one (no-op if it exists).
    execSync(`npx prisma db execute --stdin --url "${process.env.ADMIN_DATABASE_URL}"`, {
      input: `CREATE DATABASE IF NOT EXISTS \`${process.env.TEST_DATABASE_URL!.split('/').pop()!.split('?')[0]}\``,
      stdio: ['pipe', 'ignore', 'inherit'],
      cwd,
    });
  }
  execSync('npx prisma migrate deploy', { env: process.env, stdio: 'ignore', cwd });
  execSync('npx ts-node prisma/seed.ts', { env: process.env, stdio: 'ignore', cwd: __dirname + '/..' });
  const created = await createApp();
  app = created.app;
  const mail = app.get(MailService);
  jest.spyOn(mail, 'sendOtp').mockImplementation(async (to: string, code: string) => {
    otps.set(to, code);
  });
  await app.listen(0);
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  prisma = app.get(PrismaService);
});

afterAll(async () => {
  await app?.close();
});

describe('CS Card Station end-to-end', () => {
  let a: Player, b: Player, c: Player;

  it('registers with OTP, credits the welcome bonus and rotates refresh tokens', async () => {
    [a, b, c] = [await registerAndVerify('alice'), await registerAndVerify('bob'), await registerAndVerify('cara')];
    const me = await http().get('/api/v1/auth/me').set(auth(a)).expect(200);
    expect(me.body.pointsBalance).toBe(5000);
    expect(me.body.csId).toMatch(/^CS\d{8}$/);

    const login = await http().post('/api/v1/auth/login').send({ identifier: a.email, password: 'Passw0rd!x' }).expect(200);
    const r1 = await http().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    // Reusing the old refresh token is rejected and revokes the session.
    await http().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
    await http().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
    await http().post('/api/v1/auth/login').send({ identifier: a.email, password: 'wrong-pass1' }).expect(401);
  });

  it('runs password reset via OTP', async () => {
    await http().post('/api/v1/auth/forgot-password').send({ email: c.email }).expect(200);
    const code = otps.get(c.email)!;
    await http().post('/api/v1/auth/reset-password').send({ email: c.email, code, newPassword: 'NewPassw0rd!' }).expect(200);
    const l = await http().post('/api/v1/auth/login').send({ identifier: c.email, password: 'NewPassw0rd!' }).expect(200);
    c.token = l.body.accessToken;
  });

  it('handles friends, direct chat with unread counts, and blocking', async () => {
    const req = await http().post('/api/v1/friends/requests').set(auth(a)).send({ userId: b.id }).expect(201);
    const incoming = await http().get('/api/v1/friends/requests').set(auth(b)).expect(200);
    expect(incoming.body.incoming[0].user.id).toBe(a.id);
    await http().post(`/api/v1/friends/requests/${req.body.id}/accept`).set(auth(b)).expect(200);
    const list = await http().get('/api/v1/friends').set(auth(a)).expect(200);
    expect(list.body.items.map((f: { id: string }) => f.id)).toContain(b.id);

    const room = await http().post('/api/v1/chat/direct').set(auth(a)).send({ userId: b.id }).expect(200);
    const clientMsgId = randomUUID();
    await http()
      .post(`/api/v1/chat/rooms/${room.body.id}/messages`)
      .set(auth(a))
      .send({ content: 'Hi Bob! <b>gg</b>', clientMsgId })
      .expect(201);
    // Idempotent resend
    await http()
      .post(`/api/v1/chat/rooms/${room.body.id}/messages`)
      .set(auth(a))
      .send({ content: 'Hi Bob! <b>gg</b>', clientMsgId })
      .expect(201);
    const rooms = await http().get('/api/v1/chat/rooms').set(auth(b)).expect(200);
    expect(rooms.body.items.find((r: { id: string }) => r.id === room.body.id).unread).toBe(1);
    const msgs = await http().get(`/api/v1/chat/rooms/${room.body.id}/messages`).set(auth(b)).expect(200);
    expect(msgs.body.items).toHaveLength(1);
    await http().post(`/api/v1/chat/rooms/${room.body.id}/read`).set(auth(b)).expect(200);

    await http().post(`/api/v1/users/${c.id}/block`).set(auth(b)).expect(200);
    await http().post('/api/v1/chat/direct').set(auth(c)).send({ userId: b.id }).expect(403);
    await http().delete(`/api/v1/users/${c.id}/block`).set(auth(b)).expect(200);
  });

  it('manages associations with approval flow and roles', async () => {
    const created = await http()
      .post('/api/v1/associations')
      .set(auth(a))
      .send({ name: `Royals ${tag}`, joinPolicy: 'APPROVAL' })
      .expect(201);
    expect(created.body.myRole).toBe('OWNER');
    expect(created.body.publicId).toMatch(/^AS\d{7}$/);
    const j = await http().post(`/api/v1/associations/${created.body.id}/join`).set(auth(c)).expect(200);
    expect(j.body.status).toBe('PENDING');
    await http().post(`/api/v1/associations/${created.body.id}/requests/${c.id}/approve`).set(auth(b)).expect(403);
    await http().post(`/api/v1/associations/${created.body.id}/requests/${c.id}/approve`).set(auth(a)).expect(200);
    await http().patch(`/api/v1/associations/${created.body.id}/members/${c.id}`).set(auth(a)).send({ role: 'ADMIN' }).expect(200);
    const members = await http().get(`/api/v1/associations/${created.body.id}/members`).set(auth(c)).expect(200);
    expect(members.body.items).toHaveLength(2);
    const inv = await http().post(`/api/v1/associations/${created.body.id}/invitations`).set(auth(c)).send({ userId: b.id }).expect(201);
    await http().post(`/api/v1/associations/invitations/${inv.body.id}/accept`).set(auth(b)).expect(200);
    const details = await http().get(`/api/v1/associations/${created.body.publicId}`).set(auth(b)).expect(200);
    expect(details.body.memberCount).toBe(3);
    expect(details.body.chatRoomId).toBeTruthy();
  });

  it('plays a full multiplayer Teen Patti hand over Socket.IO and settles it atomically', async () => {
    const room = await http()
      .post('/api/v1/rooms')
      .set(auth(a))
      .send({
        gameCode: 'TEEN_PATTI',
        visibility: 'PRIVATE',
        password: 'secret12',
        config: { boot: 10, turnSeconds: 10 },
        buyIn: { min: 500, max: 2000 },
      })
      .expect(201);
    const roomId = room.body.id;
    const players = [a, b, c];
    const results: unknown[] = [];
    const batches = new Map<string, any[]>();
    for (const p of players) {
      p.socket = await connect(p);
      batches.set(p.id, []);
      p.socket.on('game:batch', (batch) => batches.get(p.id)!.push(batch));
      p.socket.on('game:result', (r) => results.push(r));
    }
    await expect(emit(b.socket!, 'room:join', { roomId, password: 'nope' })).rejects.toThrow(/password/i);
    for (const p of players) {
      const snap = await emit(p.socket!, 'room:join', { roomId, password: 'secret12' });
      expect(snap.room.code).toBe(room.body.code);
    }
    const before = (await http().get('/api/v1/points').set(auth(b)).expect(200)).body.balance;
    for (const [i, p] of players.entries()) await emit(p.socket!, 'room:sit', { roomId, seat: i, buyIn: 1000 });
    const bal = await http().get('/api/v1/points').set(auth(b)).expect(200);
    expect(bal.body.balance).toBe(before - 1000);

    // Wait for the dealer, then play using only server-provided legal actions.
    const deadline = Date.now() + 90_000;
    let lastSeq = 0;
    while (!results.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      for (const p of players) {
        const list = batches.get(p.id)!;
        const latest = list[list.length - 1];
        if (!latest || latest.seq <= lastSeq) continue;
        // Never see other players' cards mid-hand.
        if (latest.game?.phase !== 'COMPLETE') {
          for (const pl of latest.game?.players ?? []) if (pl.userId !== p.id) expect(pl.cards).toBeNull();
        }
        const legal = latest.legalActions as { type: string }[];
        const choice =
          legal.find((x) => x.type === 'show') ?? legal.find((x) => x.type === 'chaal') ?? legal.find((x) => x.type === 'pack');
        if (!choice) continue;
        lastSeq = latest.seq;
        await emit(p.socket!, 'room:action', { roomId, actionId: randomUUID(), type: choice.type, expectedVersion: latest.seq }).catch(
          (e) => {
            if (!/STALE|turn|resync/i.test(String(e))) throw e;
          },
        );
      }
    }
    expect(results.length).toBeGreaterThan(0);
    const result = results[0] as {
      results: { userId: string; delta: number }[];
      seedCommit: string;
      seedReveal: string;
      sessionId: string;
    };
    expect(result.results.reduce((t, r) => t + r.delta, 0)).toBe(0);
    // Fairness: the revealed seed hashes to the commitment.
    const { createHash } = await import('crypto');
    expect(createHash('sha256').update(result.seedReveal, 'hex').digest('hex')).toBe(result.seedCommit);

    // Settled atomically: history + stacks + leaderboard.
    await new Promise((r) => setTimeout(r, 500));
    const history = await prisma.gameHistory.findMany({ where: { gameSessionId: result.sessionId } });
    expect(history).toHaveLength(3);
    const seats = await prisma.roomPlayer.findMany({ where: { roomId, status: 'SEATED' } });
    expect(seats.reduce((t, s) => t + s.stack, 0)).toBe(3000);
    const lb = await http().get('/api/v1/leaderboard?period=weekly&game=TEEN_PATTI').set(auth(a)).expect(200);
    // The test DB persists between runs, so check membership rather than an exact count.
    const ranked = lb.body.items.map((e: { user: { id: string } }) => e.user.id);
    for (const p of players) expect(ranked).toContain(p.id);
    const hist = await http().get('/api/v1/history').set(auth(a)).expect(200);
    expect(hist.body.items[0].game.code).toBe('TEEN_PATTI');
    const session = await http().get(`/api/v1/history/sessions/${result.sessionId}`).set(auth(a)).expect(200);
    expect(session.body.fairness.seedReveal).toBe(result.seedReveal);

    // Leave -> stacks return to balances; ledger stays consistent.
    for (const p of players) await emit(p.socket!, 'room:leave', { roomId });
    await new Promise((r) => setTimeout(r, 7000));
    for (const p of players) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: p.id } });
      const ledger = await prisma.pointsLedger.findMany({ where: { userId: p.id }, orderBy: { createdAt: 'asc' } });
      expect(ledger.reduce((t, l) => t + l.amount, 0)).toBe(u.pointsBalance);
      expect(ledger[ledger.length - 1].balanceAfter).toBe(u.pointsBalance);
    }
    const seatedAfter = await prisma.roomPlayer.count({ where: { roomId, status: 'SEATED' } });
    expect(seatedAfter).toBe(0);
    for (const p of players) p.socket!.disconnect();
  });

  /** Seats players in a fresh room and plays until the first game:result using a strategy. */
  async function playOneHand(gameCode: string, config: Record<string, unknown>, players: Player[], choose: (legal: any[], p: Player) => Record<string, unknown> | null) {
    const room = await http().post('/api/v1/rooms').set(auth(players[0])).send({ gameCode, config, buyIn: { min: 500, max: 2000 } }).expect(201);
    const roomId = room.body.id;
    const results: any[] = [];
    const latest = new Map<string, any>();
    for (const p of players) {
      p.socket = await connect(p);
      p.socket.on('game:batch', (b) => latest.set(p.id, b));
      p.socket.on('game:result', (r) => results.push(r));
      await emit(p.socket, 'room:join', { roomId });
    }
    for (const [i, p] of players.entries()) await emit(p.socket!, 'room:sit', { roomId, seat: i, buyIn: 1000 });
    const acted = new Map<string, number>();
    const deadline = Date.now() + 60_000;
    while (!results.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      for (const p of players) {
        const b = latest.get(p.id);
        if (!b || acted.get(p.id) === b.seq || !b.legalActions?.length) continue;
        const action = choose(b.legalActions, p);
        if (!action) continue;
        acted.set(p.id, b.seq);
        await emit(p.socket!, 'room:action', { roomId, actionId: randomUUID(), expectedVersion: b.seq, ...action }).catch((e) => {
          if (!/STALE|turn|resync|closed/i.test(String(e))) throw e;
        });
      }
    }
    for (const p of players) {
      await emit(p.socket!, 'room:leave', { roomId }).catch(() => undefined);
      p.socket!.disconnect();
    }
    return { roomId, result: results[0] };
  }

  it("plays a Texas Hold'em hand to showdown over sockets", async () => {
    const { result } = await playOneHand('POKER', { smallBlind: 5, bigBlind: 10, turnSeconds: 10 }, [a, b], (legal) => {
      const pick = legal.find((x) => x.type === 'check') ?? legal.find((x) => x.type === 'call');
      return pick ? { type: pick.type } : null;
    });
    expect(result).toBeDefined();
    expect(result.results.reduce((t: number, r: any) => t + r.delta, 0)).toBe(0);
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: result.sessionId }, include: { events: true } });
    expect(session.status).toBe('COMPLETED');
    expect(session.events.filter((e) => e.type === 'BOARD_DEALT')).toHaveLength(3);
    expect(session.events.some((e) => e.type === 'SHOWDOWN')).toBe(true);
  });

  it('plays an Andar Bahar round against the house over sockets', async () => {
    const { result } = await playOneHand('ANDAR_BAHAR', { minBet: 10, bettingSeconds: 10 }, [a, b], (legal, p) => {
      if (!legal.some((x) => x.type === 'bet')) return null;
      // a bets once on Andar then locks in; b sits the round out.
      if (p === a && !(p as any)._bet) {
        (p as any)._bet = true;
        return { type: 'bet', spot: 'ANDAR', amount: 50 };
      }
      return { type: 'ready' };
    });
    expect(result).toBeDefined();
    const mine = result.results.find((r: any) => r.userId === a.id);
    expect([-50, 45, 50]).toContain(mine.delta); // lose, or win 0.9x / 1x depending on side dealt first
    const hist = await prisma.gameHistory.findMany({ where: { gameSessionId: result.sessionId } });
    expect(hist.map((h) => h.userId)).toEqual([a.id]); // non-bettors are not recorded
  });

  it('enforces admin sessions, CSRF and RBAC', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent.get('/api/v1/admin/dashboard').expect(401);
    const login = await agent
      .post('/api/v1/admin/auth/login')
      .send({ email: process.env.ADMIN_BOOTSTRAP_EMAIL, password: process.env.ADMIN_BOOTSTRAP_PASSWORD })
      .expect(200);
    expect(login.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    const dash = await agent.get('/api/v1/admin/dashboard').expect(200);
    expect(dash.body.totals.users).toBeGreaterThanOrEqual(3);
    // Mutations without the CSRF header are refused.
    await agent.post(`/api/v1/admin/users/${c.id}/status`).send({ status: 'SUSPENDED', reason: 'test' }).expect(403);
    await agent
      .post(`/api/v1/admin/users/${c.id}/status`)
      .set('x-csrf-token', login.body.csrfToken)
      .send({ status: 'SUSPENDED', reason: 'e2e test' })
      .expect(200);
    await http().get('/api/v1/auth/me').set(auth(c)).expect(403);
    await agent
      .post(`/api/v1/admin/users/${c.id}/status`)
      .set('x-csrf-token', login.body.csrfToken)
      .send({ status: 'ACTIVE', reason: 'e2e test' })
      .expect(200);

    // A support-staff admin cannot touch user status.
    const roles = await agent.get('/api/v1/admin/roles').expect(200);
    const supportRole = roles.body.items.find((r: { key: string }) => r.key === 'SUPPORT');
    const email = `support_${tag}@test.local`;
    await agent
      .post('/api/v1/admin/admins')
      .set('x-csrf-token', login.body.csrfToken)
      .send({ email, name: 'Sam', password: 'Supp0rtPass!', roleId: supportRole.id })
      .expect(201);
    const sup = request.agent(app.getHttpServer());
    const sl = await sup.post('/api/v1/admin/auth/login').send({ email, password: 'Supp0rtPass!' }).expect(200);
    await sup.get('/api/v1/admin/support').expect(200);
    await sup
      .post(`/api/v1/admin/users/${c.id}/status`)
      .set('x-csrf-token', sl.body.csrfToken)
      .send({ status: 'BANNED', reason: 'nope' })
      .expect(403);
    const audit = await agent.get('/api/v1/admin/audit?q=user.status').expect(200);
    expect(audit.body.total).toBeGreaterThanOrEqual(2);
  });
});
