import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/guards/jwt-auth.guard';
import { ChatService } from './chat.service';

class DirectDto {
  @IsUUID() userId: string;
}
class GroupDto {
  @IsString() @Length(1, 60) name: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(49) @IsUUID('4', { each: true }) memberIds: string[];
}
export class SendMessageDto {
  @IsString() @Length(1, 1000) content: string;
  @IsOptional() @IsString() @Length(8, 64) clientMsgId?: string;
}
class MuteDto {
  @IsInt() @Min(0) @Max(24 * 365) hours: number;
}
class AddMemberDto {
  @IsUUID() userId: string;
}

@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('rooms')
  rooms(@CurrentUser() u: AuthUser) {
    return this.chat.listRooms(u.id);
  }

  @Post('direct')
  @HttpCode(200)
  direct(@CurrentUser() u: AuthUser, @Body() dto: DirectDto) {
    return this.chat.ensureDirect(u.id, dto.userId);
  }

  @Post('groups')
  group(@CurrentUser() u: AuthUser, @Body() dto: GroupDto) {
    return this.chat.createGroup(u.id, dto.name, dto.memberIds);
  }

  @Get('rooms/:id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('before') before?: string) {
    return this.chat.messages(u.id, id, before);
  }

  @Post('rooms/:id/messages')
  send(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) {
    return this.chat.send(u.id, id, dto.content, dto.clientMsgId);
  }

  @Post('rooms/:id/read')
  @HttpCode(200)
  read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.markRead(u.id, id);
  }

  @Post('rooms/:id/mute')
  @HttpCode(200)
  mute(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MuteDto) {
    return this.chat.mute(u.id, id, dto.hours);
  }

  @Post('rooms/:id/members')
  add(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMemberDto) {
    return this.chat.addToGroup(u.id, id, dto.userId);
  }

  @Post('rooms/:id/leave')
  @HttpCode(200)
  leave(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.leaveGroup(u.id, id);
  }

  @Delete('messages/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.deleteMessage(u.id, id);
  }
}
