/* Idempotent seed: safe to run repeatedly. */
import { GameCode, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { PERMISSIONS, ROLE_PRESETS } from '../src/admin/admin.guard';

const prisma = new PrismaClient();

const CATEGORIES = [
  { slug: 'classic-cards', name: 'Classic Cards', sortOrder: 1 },
  { slug: 'poker-room', name: 'Poker Room', sortOrder: 2 },
  { slug: 'quick-play', name: 'Quick Play', sortOrder: 3 },
];

const GAMES: {
  code: GameCode;
  name: string;
  tagline: string;
  description: string;
  category: string;
  minPlayers: number;
  maxPlayers: number;
  featured: boolean;
  sortOrder: number;
}[] = [
  {
    code: 'TEEN_PATTI',
    name: 'Teen Patti',
    tagline: 'Three cards. Nerves of steel.',
    description:
      'Classic three-card game. Play blind or seen, raise the stake, request a side show or call for a show when two players remain. Trail beats pure sequence, sequence, color, pair and high card.',
    category: 'classic-cards',
    minPlayers: 2,
    maxPlayers: 6,
    featured: true,
    sortOrder: 1,
  },
  {
    code: 'POKER',
    name: "Texas Hold'em",
    tagline: 'No-limit. Five on the board.',
    description:
      "No-Limit Texas Hold'em. Two hole cards, five community cards, best five-card hand wins. Blinds, side pots and all-ins handled by the dealer.",
    category: 'poker-room',
    minPlayers: 2,
    maxPlayers: 9,
    featured: true,
    sortOrder: 2,
  },
  {
    code: 'OMAHA',
    name: 'Pot-Limit Omaha',
    tagline: 'Four cards. Use exactly two.',
    description:
      'Pot-Limit Omaha. Four hole cards; every hand uses exactly two hole cards and three board cards. Raises are capped at the size of the pot.',
    category: 'poker-room',
    minPlayers: 2,
    maxPlayers: 6,
    featured: false,
    sortOrder: 3,
  },
  {
    code: 'RUMMY',
    name: 'Rummy',
    tagline: '13 cards. Meld to win.',
    description:
      '13-card points rummy with two decks and printed plus wild jokers. Form at least two sequences including one pure sequence, then declare. Drop early for fewer points.',
    category: 'classic-cards',
    minPlayers: 2,
    maxPlayers: 6,
    featured: true,
    sortOrder: 4,
  },
  {
    code: 'ANDAR_BAHAR',
    name: 'Andar Bahar',
    tagline: 'Inside or outside?',
    description:
      'A game card is opened. Bet Andar or Bahar, then cards are dealt alternately until one matches its rank. Fast, simple and full of suspense.',
    category: 'quick-play',
    minPlayers: 1,
    maxPlayers: 10,
    featured: false,
    sortOrder: 5,
  },
  {
    code: 'BACCARAT',
    name: 'Baccarat',
    tagline: 'Player, Banker or Tie.',
    description: 'Punto Banco baccarat with the standard third-card tableau. Back Player, Banker or Tie, plus pair side bets.',
    category: 'quick-play',
    minPlayers: 1,
    maxPlayers: 10,
    featured: false,
    sortOrder: 6,
  },
  {
    code: 'GOLD_MINES',
    name: 'Gold Mines',
    tagline: 'Dig for gold. Dodge the mines.',
    description:
      'Choose how many mines hide in the grid, then dig. Every gold tile raises your multiplier - cash out before you strike a mine.',
    category: 'quick-play',
    minPlayers: 1,
    maxPlayers: 8,
    featured: true,
    sortOrder: 7,
  },
];

const GIFTS = [
  { code: 'rose', name: 'Rose', icon: 'rose', animation: 'float', pricePoints: 50, sortOrder: 1 },
  { code: 'coffee', name: 'Coffee', icon: 'coffee', animation: 'float', pricePoints: 80, sortOrder: 2 },
  { code: 'clover', name: 'Lucky Clover', icon: 'clover', animation: 'spin', pricePoints: 150, sortOrder: 3 },
  { code: 'trophy', name: 'Trophy', icon: 'trophy', animation: 'burst', pricePoints: 400, sortOrder: 4 },
  { code: 'crown', name: 'Royal Crown', icon: 'crown', animation: 'sparkle', pricePoints: 1000, sortOrder: 5 },
  { code: 'fireworks', name: 'Fireworks', icon: 'fireworks', animation: 'burst', pricePoints: 2500, sortOrder: 6 },
  { code: 'diamond', name: 'Diamond', icon: 'diamond', animation: 'rain', pricePoints: 5000, sortOrder: 7 },
];

const ACHIEVEMENTS = [
  {
    code: 'first_hand',
    name: 'Take a Seat',
    description: 'Play your first hand',
    icon: 'cards',
    metric: 'games_played',
    threshold: 1,
    rewardPoints: 200,
  },
  {
    code: 'hands_50',
    name: 'Regular',
    description: 'Play 50 hands',
    icon: 'cards',
    metric: 'games_played',
    threshold: 50,
    rewardPoints: 1000,
  },
  {
    code: 'hands_500',
    name: 'Table Veteran',
    description: 'Play 500 hands',
    icon: 'medal',
    metric: 'games_played',
    threshold: 500,
    rewardPoints: 5000,
  },
  {
    code: 'first_win',
    name: 'First Blood',
    description: 'Win your first hand',
    icon: 'trophy',
    metric: 'games_won',
    threshold: 1,
    rewardPoints: 300,
  },
  {
    code: 'wins_25',
    name: 'Card Shark',
    description: 'Win 25 hands',
    icon: 'trophy',
    metric: 'games_won',
    threshold: 25,
    rewardPoints: 1500,
  },
  {
    code: 'wins_100',
    name: 'High Roller',
    description: 'Win 100 hands',
    icon: 'crown',
    metric: 'games_won',
    threshold: 100,
    rewardPoints: 5000,
  },
  {
    code: 'tp_wins_10',
    name: 'Teen Patti Ace',
    description: 'Win 10 Teen Patti hands',
    icon: 'spade',
    metric: 'games_won',
    threshold: 10,
    gameCode: 'TEEN_PATTI' as GameCode,
    rewardPoints: 1000,
  },
  {
    code: 'poker_wins_10',
    name: 'River Rat',
    description: "Win 10 Hold'em hands",
    icon: 'chip',
    metric: 'games_won',
    threshold: 10,
    gameCode: 'POKER' as GameCode,
    rewardPoints: 1000,
  },
  {
    code: 'rummy_wins_5',
    name: 'Meld Master',
    description: 'Win 5 Rummy hands',
    icon: 'heart',
    metric: 'games_won',
    threshold: 5,
    gameCode: 'RUMMY' as GameCode,
    rewardPoints: 800,
  },
  {
    code: 'friends_5',
    name: 'Social Butterfly',
    description: 'Make 5 friends',
    icon: 'friends',
    metric: 'friends_count',
    threshold: 5,
    rewardPoints: 500,
  },
  {
    code: 'association_1',
    name: 'Joined Up',
    description: 'Join an association',
    icon: 'shield',
    metric: 'associations_joined',
    threshold: 1,
    rewardPoints: 300,
  },
  {
    code: 'streak_7',
    name: 'Dedicated',
    description: 'Claim the daily reward 7 days in a row',
    icon: 'calendar',
    metric: 'daily_streak',
    threshold: 7,
    rewardPoints: 1000,
  },
  {
    code: 'gifts_10',
    name: 'Generous',
    description: 'Send 10 gifts',
    icon: 'gift',
    metric: 'gifts_sent',
    threshold: 10,
    rewardPoints: 500,
  },
];

const BANNERS = [
  {
    title: 'Welcome to CS Card Station',
    subtitle: 'Claim your daily reward and take a seat',
    theme: 'gold',
    sortOrder: 1,
    linkUrl: 'cs://rewards',
  },
  {
    title: 'Teen Patti Royale',
    subtitle: 'The classic three-card showdown is live',
    theme: 'green',
    sortOrder: 2,
    linkUrl: 'cs://games/TEEN_PATTI',
  },
  {
    title: 'Build your Association',
    subtitle: 'Create private tables for your crew',
    theme: 'blue',
    sortOrder: 3,
    linkUrl: 'cs://associations',
  },
];

async function main() {
  for (const c of CATEGORIES)
    await prisma.gameCategory.upsert({ where: { slug: c.slug }, create: c, update: { name: c.name, sortOrder: c.sortOrder } });
  const cats = await prisma.gameCategory.findMany();
  for (const g of GAMES) {
    const categoryId = cats.find((c) => c.slug === g.category)!.id;
    const data = {
      name: g.name,
      tagline: g.tagline,
      description: g.description,
      categoryId,
      minPlayers: g.minPlayers,
      maxPlayers: g.maxPlayers,
      sortOrder: g.sortOrder,
    };
    await prisma.game.upsert({ where: { code: g.code }, create: { code: g.code, isFeatured: g.featured, config: {}, ...data }, update: data });
  }
  for (const g of GIFTS)
    await prisma.gift.upsert({ where: { code: g.code }, create: g, update: { name: g.name, icon: g.icon, animation: g.animation } });
  for (const a of ACHIEVEMENTS)
    await prisma.achievement.upsert({ where: { code: a.code }, create: a, update: { name: a.name, description: a.description } });
  if ((await prisma.banner.count()) === 0) await prisma.banner.createMany({ data: BANNERS });

  for (const key of PERMISSIONS) await prisma.adminPermission.upsert({ where: { key }, create: { key }, update: {} });
  const perms = await prisma.adminPermission.findMany();
  for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
    const role = await prisma.adminRole.upsert({
      where: { key },
      create: { key, name: preset.name, isSystem: true },
      update: { name: preset.name, isSystem: true },
    });
    const existing = await prisma.adminRolePermission.count({ where: { roleId: role.id } });
    if (existing === 0) {
      const keys = preset.permissions === 'ALL' ? PERMISSIONS : preset.permissions;
      await prisma.adminRolePermission.createMany({
        data: perms.filter((p) => (keys as readonly string[]).includes(p.key)).map((p) => ({ roleId: role.id, permissionId: p.id })),
        skipDuplicates: true,
      });
    }
  }

  const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (email && password) {
    const exists = await prisma.adminUser.findUnique({ where: { email } });
    if (!exists) {
      const role = await prisma.adminRole.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
      await prisma.adminUser.create({
        data: {
          email,
          name: 'Super Admin',
          roleId: role.id,
          passwordHash: await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
        },
      });
      console.log(`Bootstrap super admin created: ${email} (change the password after first login)`);
    }
  } else console.log('ADMIN_BOOTSTRAP_EMAIL/PASSWORD not set - skipping super admin bootstrap');
  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
