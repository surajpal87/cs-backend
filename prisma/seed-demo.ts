/*
 * DEVELOPMENT-ONLY demo data: verified test players with known passwords, friendships, an
 * association, and one admin per role. Idempotent. Refuses to run when NODE_ENV=production.
 *
 *   npm run db:seed        # catalog, roles, permissions (required first)
 *   npm run db:seed:demo   # this file
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to create demo accounts with known passwords in production.');
  process.exit(1);
}

const prisma = new PrismaClient();
const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const DEMO_PLAYER_PASSWORD = 'Player#2026';
const START_POINTS = 50_000;

const PLAYERS = [
  { username: 'alice', displayName: 'Alice Ace', csId: 'CS10000001', avatar: 'royal-1' },
  { username: 'bob', displayName: 'Bob Bluff', csId: 'CS10000002', avatar: 'royal-2' },
  { username: 'cara', displayName: 'Cara Chips', csId: 'CS10000003', avatar: 'royal-3' },
  { username: 'dev', displayName: 'Dev Dealer', csId: 'CS10000004', avatar: 'royal-4' },
];

const ADMINS = [
  { email: 'superadmin@demo.cardstation.local', name: 'Demo Super Admin', role: 'SUPER_ADMIN', password: 'SuperAdmin#2026' },
  { email: 'admin@demo.cardstation.local', name: 'Demo Admin', role: 'ADMIN', password: 'Admin#2026' },
  { email: 'moderator@demo.cardstation.local', name: 'Demo Moderator', role: 'MODERATOR', password: 'Moderator#2026' },
  { email: 'support@demo.cardstation.local', name: 'Demo Support', role: 'SUPPORT', password: 'Support#2026' },
];

const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

async function main() {
  const playerHash = await argon2.hash(DEMO_PLAYER_PASSWORD, ARGON);
  const ids: Record<string, string> = {};

  for (const p of PLAYERS) {
    const email = `${p.username}@demo.cardstation.local`;
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        username: p.username,
        csId: p.csId,
        passwordHash: playerHash,
        status: 'ACTIVE',
        emailVerified: true,
        profile: { create: { displayName: p.displayName, avatarPreset: p.avatar, preferences: {} } },
      },
      update: { passwordHash: playerHash, status: 'ACTIVE', emailVerified: true },
    });
    ids[p.username] = user.id;
    // Top up to the demo starting balance through the ledger (keeps balance == sum(ledger)).
    const missing = START_POINTS - user.pointsBalance;
    if (missing > 0) {
      await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({ where: { id: user.id }, data: { pointsBalance: { increment: missing } } });
        await tx.pointsLedger.create({
          data: {
            userId: user.id,
            type: 'ADMIN_ADJUSTMENT',
            amount: missing,
            balanceAfter: u.pointsBalance,
            idempotencyKey: `demo-topup:${user.id}:${Date.now()}`,
            note: 'Demo account starting points',
          },
        });
      });
    }
  }

  // alice <-> bob and alice <-> cara are friends; dev has a pending request to alice.
  for (const [x, y] of [
    ['alice', 'bob'],
    ['alice', 'cara'],
  ]) {
    const [a, b] = pair(ids[x], ids[y]);
    await prisma.friendship.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, create: { userAId: a, userBId: b }, update: {} });
  }
  const pending = await prisma.friendRequest.findFirst({ where: { senderId: ids.dev, receiverId: ids.alice, status: 'PENDING' } });
  if (!pending) await prisma.friendRequest.create({ data: { senderId: ids.dev, receiverId: ids.alice } });

  // Association owned by alice with bob as a member (and its chat room).
  let assoc = await prisma.association.findFirst({ where: { publicId: 'AS1000001' } });
  if (!assoc) {
    assoc = await prisma.association.create({
      data: {
        publicId: 'AS1000001',
        name: 'Royal Flush Club',
        description: 'Demo association for local testing',
        joinPolicy: 'APPROVAL',
        ownerId: ids.alice,
        memberCount: 2,
        members: { create: [{ userId: ids.alice, role: 'OWNER' }, { userId: ids.bob, role: 'MEMBER' }] },
        chatRoom: { create: { type: 'ASSOCIATION', name: 'Royal Flush Club', members: { create: [{ userId: ids.alice }, { userId: ids.bob }] } } },
      },
    });
  }

  for (const a of ADMINS) {
    const role = await prisma.adminRole.findUnique({ where: { key: a.role } });
    if (!role) throw new Error(`Role ${a.role} missing - run "npm run db:seed" first`);
    const passwordHash = await argon2.hash(a.password, ARGON);
    await prisma.adminUser.upsert({
      where: { email: a.email },
      create: { email: a.email, name: a.name, roleId: role.id, passwordHash },
      update: { roleId: role.id, passwordHash, status: 'ACTIVE' },
    });
  }

  console.log('Demo data ready:');
  console.table(PLAYERS.map((p) => ({ username: p.username, email: `${p.username}@demo.cardstation.local`, password: DEMO_PLAYER_PASSWORD, csId: p.csId })));
  console.table(ADMINS.map((a) => ({ email: a.email, password: a.password, role: a.role })));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
