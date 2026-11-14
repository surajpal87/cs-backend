import { Body, Controller, Delete, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

class MarkReadDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('4', { each: true }) ids?: string[];
}
class DeviceDto {
  @IsString() @Length(10, 512) token: string;
  @IsIn(['android', 'ios', 'web']) platform: string;
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('cursor') cursor?: string) {
    return this.svc.list(u.id, cursor);
  }

  @Post('read')
  @HttpCode(200)
  read(@CurrentUser() u: AuthUser, @Body() dto: MarkReadDto) {
    return this.svc.markRead(u.id, dto.ids);
  }

  @Post('devices')
  @HttpCode(200)
  register(@CurrentUser() u: AuthUser, @Body() dto: DeviceDto) {
    return this.svc.registerDevice(u.id, dto.token, dto.platform);
  }

  @Delete('devices')
  unregister(@CurrentUser() u: AuthUser, @Body() dto: DeviceDto) {
    return this.svc.unregisterDevice(u.id, dto.token);
  }
}
