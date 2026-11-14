import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma/prisma.service';

/** Typed defaults for admin-editable system settings. */
export const SETTING_DEFAULTS = {
  'points.signupBonus': 5000,
  'points.dailyRewards': [100, 150, 200, 300, 400, 500, 1000],
  'points.minTableBuyIn': 100,
  'chat.maxMessageLength': 1000,
  'rooms.maxPerUser': 3,
  'maintenance.enabled': false,
  'maintenance.message': 'We are performing scheduled maintenance. Please try again soon.',
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

@Injectable()
export class SettingsService {
  private cache = new Map<string, { v: unknown; at: number }>();
  constructor(private readonly prisma: PrismaService) {}

  async get<K extends SettingKey>(key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.v as (typeof SETTING_DEFAULTS)[K];
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    const v = (row?.value ?? SETTING_DEFAULTS[key]) as (typeof SETTING_DEFAULTS)[K];
    this.cache.set(key, { v, at: Date.now() });
    return v;
  }

  async all(): Promise<{ key: string; value: unknown; isDefault: boolean; description: string | null }[]> {
    const rows = await this.prisma.systemSetting.findMany();
    const map = new Map(rows.map((r) => [r.key, r]));
    return Object.entries(SETTING_DEFAULTS).map(([key, def]) => ({
      key,
      value: map.get(key)?.value ?? def,
      isDefault: !map.has(key),
      description: map.get(key)?.description ?? null,
    }));
  }

  async set(key: SettingKey, value: unknown, adminId: string) {
    const def = SETTING_DEFAULTS[key];
    if (def === undefined) throw new Error('Unknown setting');
    if (typeof def !== typeof value || Array.isArray(def) !== Array.isArray(value)) {
      throw new Error(`Setting ${key} must be of type ${Array.isArray(def) ? 'array' : typeof def}`);
    }
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: value as Prisma.InputJsonValue, updatedById: adminId },
      update: { value: value as Prisma.InputJsonValue, updatedById: adminId },
    });
    this.cache.delete(key);
  }
}
