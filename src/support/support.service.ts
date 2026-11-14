import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { sanitizeText } from '../chat/chat.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

export const TICKET_CATEGORIES = ['ACCOUNT', 'GAMEPLAY', 'POINTS', 'REPORT_PLAYER', 'BUG', 'FEEDBACK', 'OTHER'];

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(userId: string, subject: string, category: string, body: string) {
    const open = await this.prisma.supportTicket.count({ where: { userId, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_USER'] } } });
    if (open >= 5) throw new BadRequestException({ code: 'TICKET_LIMIT', message: 'You have too many open tickets' });
    const t = await this.prisma.supportTicket.create({
      data: {
        userId,
        subject: sanitizeText(subject, 120),
        category,
        messages: { create: { authorId: userId, body: sanitizeText(body, 4000) } },
      },
      include: { messages: true },
    });
    return t;
  }

  list(userId: string) {
    return this.prisma.supportTicket.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' } }).then((items) => ({ items }));
  }

  async get(userId: string, id: string) {
    const t = await this.prisma.supportTicket.findFirst({
      where: { id, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!t) throw new NotFoundException({ code: 'TICKET_NOT_FOUND', message: 'Ticket not found' });
    return t;
  }

  async reply(userId: string, id: string, body: string) {
    const t = await this.get(userId, id);
    if (t.status === 'CLOSED') throw new BadRequestException({ code: 'TICKET_CLOSED', message: 'This ticket is closed' });
    await this.prisma.$transaction([
      this.prisma.supportMessage.create({ data: { ticketId: id, authorId: userId, body: sanitizeText(body, 4000) } }),
      this.prisma.supportTicket.update({
        where: { id },
        data: { status: t.status === 'WAITING_USER' || t.status === 'RESOLVED' ? 'OPEN' : t.status },
      }),
    ]);
    return this.get(userId, id);
  }

  // Staff side (used by admin module)
  async staffReply(adminId: string, id: string, body: string, status?: TicketStatus) {
    const t = await this.prisma.supportTicket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Ticket not found');
    await this.prisma.$transaction([
      this.prisma.supportMessage.create({ data: { ticketId: id, authorId: adminId, fromStaff: true, body: sanitizeText(body, 4000) } }),
      this.prisma.supportTicket.update({
        where: { id },
        data: { status: status ?? 'WAITING_USER', assignedToId: t.assignedToId ?? adminId },
      }),
    ]);
    await this.notifications.notify(t.userId, 'SUPPORT_REPLY', 'Support replied to your ticket', t.subject, { ticketId: id });
    return this.prisma.supportTicket.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
  }
}
