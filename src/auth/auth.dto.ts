import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;
export const PASSWORD_MESSAGE = 'Password must be 8-72 characters and include a letter and a number';

export class RegisterDto {
  @ApiProperty() @Transform(lower) @IsEmail() @MaxLength(254) email: string;
  @ApiProperty({ description: '3-20 chars: letters, numbers, underscore' })
  @Transform(trim)
  @Matches(/^[A-Za-z0-9_]{3,20}$/, { message: 'Username must be 3-20 letters, numbers or underscores' })
  username: string;
  @ApiProperty() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) password: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @Length(2, 40) displayName?: string;
}

export enum OtpPurposeDto {
  REGISTER = 'REGISTER',
  RESET_PASSWORD = 'RESET_PASSWORD',
}

export class VerifyOtpDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @Matches(/^\d{6}$/, { message: 'Code must be 6 digits' }) code: string;
}

export class ResendOtpDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty({ enum: OtpPurposeDto }) @IsEnum(OtpPurposeDto) purpose: OtpPurposeDto;
}

export class LoginDto {
  @ApiProperty({ description: 'Email or username' }) @Transform(trim) @IsString() @Length(3, 254) identifier: string;
  @ApiProperty() @IsString() @Length(1, 72) password: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
}

export class RefreshDto {
  @ApiProperty() @IsString() @Length(20, 200) refreshToken: string;
}

export class LogoutDto {
  @ApiPropertyOptional() @IsOptional() @IsString() refreshToken?: string;
  @ApiPropertyOptional({ description: 'Revoke every session for this account' }) @IsOptional() allDevices?: boolean;
}

export class ForgotPasswordDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
}

export class ResetPasswordDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @Matches(/^\d{6}$/) code: string;
  @ApiProperty() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) newPassword: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() currentPassword: string;
  @ApiProperty() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE }) newPassword: string;
}
