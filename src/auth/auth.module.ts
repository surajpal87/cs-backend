import { Module } from '@nestjs/common';
import { VirtualPointsModule } from '../points/points.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({ imports: [VirtualPointsModule], controllers: [AuthController], providers: [AuthService], exports: [AuthService] })
export class AuthModule {}
