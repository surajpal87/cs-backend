import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/guards/jwt-auth.guard';
import { GiftsService } from './gifts.service';

class SendGiftDto {
  @IsUUID() toUserId: string;
  @IsString() @Length(2, 32) giftCode: string;
  @IsOptional() @IsString() @MaxLength(140) message?: string;
  @IsOptional() @IsUUID() requestId?: string;
}

@ApiTags('gifts')
@ApiBearerAuth()
@Controller('gifts')
export class GiftsController {
  constructor(private readonly gifts: GiftsService) {}

  @Get()
  catalog() {
    return this.gifts.catalog();
  }

  @Get('history')
  history(@CurrentUser() u: AuthUser) {
    return this.gifts.history(u.id);
  }

  @Post('send')
  send(@CurrentUser() u: AuthUser, @Body() dto: SendGiftDto) {
    return this.gifts.send(u.id, dto.toUserId, dto.giftCode, { message: dto.message, idempotencyKey: dto.requestId });
  }
}
