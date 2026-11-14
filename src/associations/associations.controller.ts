import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AssociationJoinPolicy, AssociationVisibility } from '@prisma/client';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/guards/jwt-auth.guard';
import { AssociationsService } from './associations.service';

const EMBLEMS = ['crown', 'spade', 'heart', 'diamond', 'club', 'star', 'shield', 'flame', 'lion', 'eagle'];

class CreateAssociationDto {
  @IsString() @Length(3, 48) name: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsEnum(AssociationVisibility) visibility?: AssociationVisibility;
  @IsOptional() @IsEnum(AssociationJoinPolicy) joinPolicy?: AssociationJoinPolicy;
  @IsOptional() @IsIn(EMBLEMS) emblem?: string;
  @IsOptional() @IsInt() @Min(5) @Max(500) maxMembers?: number;
}
class UpdateAssociationDto {
  @IsOptional() @IsString() @Length(3, 48) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsEnum(AssociationVisibility) visibility?: AssociationVisibility;
  @IsOptional() @IsEnum(AssociationJoinPolicy) joinPolicy?: AssociationJoinPolicy;
  @IsOptional() @IsIn(EMBLEMS) emblem?: string;
  @IsOptional() @IsInt() @Min(5) @Max(500) maxMembers?: number;
}
class UserRefDto {
  @IsUUID() userId: string;
}
class RoleDto {
  @IsIn(['ADMIN', 'MEMBER']) role: 'ADMIN' | 'MEMBER';
}
class KickDto {
  @IsOptional() @IsBoolean() ban?: boolean;
}

@ApiTags('associations')
@ApiBearerAuth()
@Controller('associations')
export class AssociationsController {
  constructor(private readonly svc: AssociationsService) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateAssociationDto) {
    return this.svc.create(u.id, dto);
  }

  @Get()
  discover(@CurrentUser() u: AuthUser, @Query('q') q?: string) {
    return this.svc.discover(u.id, q);
  }

  @Get('mine')
  mine(@CurrentUser() u: AuthUser) {
    return this.svc.mine(u.id);
  }

  @Get('invitations')
  invitations(@CurrentUser() u: AuthUser) {
    return this.svc.myInvitations(u.id);
  }

  @Post('invitations/:invId/accept')
  @HttpCode(200)
  acceptInvite(@CurrentUser() u: AuthUser, @Param('invId', ParseUUIDPipe) invId: string) {
    return this.svc.respondInvitation(u.id, invId, true);
  }

  @Post('invitations/:invId/reject')
  @HttpCode(200)
  rejectInvite(@CurrentUser() u: AuthUser, @Param('invId', ParseUUIDPipe) invId: string) {
    return this.svc.respondInvitation(u.id, invId, false);
  }

  @Get(':id')
  details(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.details(u.id, id);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateAssociationDto) {
    return this.svc.update(u.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.id, id);
  }

  @Post(':id/join')
  @HttpCode(200)
  join(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.join(u.id, id);
  }

  @Post(':id/leave')
  @HttpCode(200)
  leave(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.leave(u.id, id);
  }

  @Get(':id/members')
  members(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('status') status?: 'ACTIVE' | 'PENDING' | 'BANNED') {
    return this.svc.members(u.id, id, status ?? 'ACTIVE');
  }

  @Get(':id/activity')
  activity(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.activity(u.id, id);
  }

  @Post(':id/requests/:userId/approve')
  @HttpCode(200)
  approve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.svc.decideRequest(u.id, id, userId, true);
  }

  @Post(':id/requests/:userId/reject')
  @HttpCode(200)
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.svc.decideRequest(u.id, id, userId, false);
  }

  @Get(':id/invitations')
  sent(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.sentInvitations(u.id, id);
  }

  @Post(':id/invitations')
  invite(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UserRefDto) {
    return this.svc.invite(u.id, id, dto.userId);
  }

  @Delete(':id/invitations/:invId')
  cancelInvite(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('invId', ParseUUIDPipe) invId: string) {
    return this.svc.cancelInvitation(u.id, id, invId);
  }

  @Patch(':id/members/:userId')
  role(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: RoleDto) {
    return this.svc.setRole(u.id, id, userId, dto.role);
  }

  @Post(':id/members/:userId/remove')
  @HttpCode(200)
  kick(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: KickDto) {
    return this.svc.kick(u.id, id, userId, !!dto.ban);
  }

  @Post(':id/members/:userId/unban')
  @HttpCode(200)
  unban(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.svc.unban(u.id, id, userId);
  }

  @Post(':id/transfer')
  @HttpCode(200)
  transfer(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UserRefDto) {
    return this.svc.transfer(u.id, id, dto.userId);
  }
}
