import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/guards/jwt-auth.guard';
import { FriendsService } from './friends.service';

class SendRequestDto {
  @IsUUID() userId: string;
}

@ApiTags('friends')
@ApiBearerAuth()
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.friends.list(u.id);
  }

  @Get('requests')
  requests(@CurrentUser() u: AuthUser) {
    return this.friends.requests(u.id);
  }

  @Post('requests')
  send(@CurrentUser() u: AuthUser, @Body() dto: SendRequestDto) {
    return this.friends.send(u.id, dto.userId);
  }

  @Post('requests/:id/accept')
  @HttpCode(200)
  accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.friends.accept(u.id, id);
  }

  @Post('requests/:id/reject')
  @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.friends.reject(u.id, id);
  }

  @Delete('requests/:id')
  cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.friends.cancel(u.id, id);
  }

  @Delete(':userId')
  remove(@CurrentUser() u: AuthUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.friends.remove(u.id, userId);
  }
}
