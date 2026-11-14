import { Injectable, Logger } from '@nestjs/common';
import { ActorType, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';

export interface AuditEntry {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Tx) {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
        ip: entry.ip ?? null,
      },
    });
    this.log.log(`${entry.actorType}:${entry.actorId ?? '-'} ${entry.action} ${entry.targetType ?? ''}:${entry.targetId ?? ''}`);
  }
}
