import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/guards/jwt-auth.guard';
import { UsersService } from './users.service';

export const TABLE_THEMES = ['classic_green', 'royal_gold', 'midnight_blue', 'diamond_black', 'luxury_red'];

class UpdateProfileDto {
  @IsOptional() @IsString() @Length(2, 40) displayName?: string;
  @IsOptional() @IsString() @MaxLength(280) bio?: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string;
  @IsOptional() @Matches(/^royal-[1-8]$/) avatarPreset?: string;
  @IsOptional() @IsBoolean() showOnlineStatus?: boolean;
  @IsOptional() @IsBoolean() allowFriendRequests?: boolean;
  @IsOptional() @IsBoolean() allowRoomInvites?: boolean;
  @IsOptional() @IsIn(TABLE_THEMES) tableTheme?: string;
  @IsOptional() @IsObject() preferences?: Record<string, unknown>;
}

class ReportDto {
  @IsIn(['CHEATING', 'ABUSE', 'SPAM', 'INAPPROPRIATE_NAME', 'HARASSMENT', 'OTHER']) reason: string;
  @IsOptional() @IsString() @MaxLength(1000) details?: string;
  @IsOptional() @IsUUID() messageId?: string;
}

class DeleteAccountDto {
  @IsString() @Length(1, 72) password: string;
}

@ApiTags('users')
@ApiBearerAuth()
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users/search')
  search(@CurrentUser() u: AuthUser, @Query('q') q = '') {
    return this.users.search(u.id, q);
  }

  @Get('users/me/blocked')
  blocked(@CurrentUser() u: AuthUser) {
    return this.users.blocked(u.id);
  }

  @Get('users/:id')
  profile(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.users.publicProfile(u.id, id);
  }

  @Post('users/:id/block')
  @HttpCode(200)
  block(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.block(u.id, id);
  }

  @Delete('users/:id/block')
  unblock(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.unblock(u.id, id);
  }

  @Post('users/:id/report')
  report(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportDto) {
    return this.users.report(u.id, id, dto.reason, dto.details, dto.messageId);
  }

  @Get('profile')
  me(@CurrentUser() u: AuthUser) {
    return this.users.publicProfile(u.id, u.id);
  }

  @Patch('profile')
  update(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(u.id, dto);
  }

  @Get('profile/stats')
  stats(@CurrentUser() u: AuthUser) {
    return this.users.stats(u.id);
  }

  @Delete('account')
  @HttpCode(200)
  deleteAccount(@CurrentUser() u: AuthUser, @Body() dto: DeleteAccountDto) {
    return this.users.deleteAccount(u.id, dto.password);
  }
}
