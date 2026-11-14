import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';

@Module({ controllers: [NotificationsController], providers: [PushService, NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
