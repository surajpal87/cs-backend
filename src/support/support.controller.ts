import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';
import { AuthUser, CurrentUser, Public } from '../common/guards/jwt-auth.guard';
import { SupportService, TICKET_CATEGORIES } from './support.service';

class CreateTicketDto {
  @IsString() @Length(4, 120) subject: string;
  @IsIn(TICKET_CATEGORIES) category: string;
  @IsString() @Length(10, 4000) body: string;
}
class ReplyDto {
  @IsString() @Length(1, 4000) body: string;
}

const FAQ = [
  {
    q: 'Are points real money?',
    a: 'No. CS Card Station is free-to-play. Points are virtual, have no cash value and cannot be redeemed, sold or transferred.',
  },
  {
    q: 'How do I get more points?',
    a: 'Claim the daily reward, unlock achievements and win hands. Your welcome bonus is credited when you verify your email.',
  },
  {
    q: 'What happens if I disconnect during a hand?',
    a: 'Your seat is kept. If it is your turn the timer continues and the default action (check or fold) is taken when it runs out. Reconnect to resume.',
  },
  {
    q: 'How do I know the cards are fair?',
    a: 'Every hand publishes a SHA-256 commitment of its shuffle seed before dealing and reveals the seed afterwards. You can verify it from Game History.',
  },
  { q: 'How do I report a player?', a: 'Open their profile, tap the menu and choose Report. Our moderators review every report.' },
  {
    q: 'How do I delete my account?',
    a: 'Settings > Account > Delete account. You must leave any tables and transfer associations you own first.',
  },
];

@ApiTags('support')
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Public()
  @Get('faq')
  faq() {
    return { items: FAQ, categories: TICKET_CATEGORIES };
  }

  @ApiBearerAuth()
  @Post('tickets')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateTicketDto) {
    return this.support.create(u.id, dto.subject, dto.category, dto.body);
  }

  @ApiBearerAuth()
  @Get('tickets')
  list(@CurrentUser() u: AuthUser) {
    return this.support.list(u.id);
  }

  @ApiBearerAuth()
  @Get('tickets/:id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.support.get(u.id, id);
  }

  @ApiBearerAuth()
  @Post('tickets/:id/messages')
  reply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplyDto) {
    return this.support.reply(u.id, id, dto.body);
  }
}
