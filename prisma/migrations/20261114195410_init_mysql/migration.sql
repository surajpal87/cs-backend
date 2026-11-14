-- CreateTable
CREATE TABLE `User` (
    `id` CHAR(36) NOT NULL,
    `csId` VARCHAR(16) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `username` VARCHAR(24) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `status` ENUM('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED') NOT NULL DEFAULT 'PENDING_VERIFICATION',
    `emailVerified` BOOLEAN NOT NULL DEFAULT false,
    `pointsBalance` INTEGER NOT NULL DEFAULT 0,
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `User_csId_key`(`csId`),
    UNIQUE INDEX `User_email_key`(`email`),
    UNIQUE INDEX `User_username_key`(`username`),
    INDEX `User_status_idx`(`status`),
    INDEX `User_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Profile` (
    `userId` CHAR(36) NOT NULL,
    `displayName` VARCHAR(40) NOT NULL,
    `avatarUrl` VARCHAR(512) NULL,
    `avatarPreset` VARCHAR(32) NOT NULL DEFAULT 'royal-1',
    `bio` VARCHAR(280) NULL,
    `country` VARCHAR(2) NULL,
    `showOnlineStatus` BOOLEAN NOT NULL DEFAULT true,
    `allowFriendRequests` BOOLEAN NOT NULL DEFAULT true,
    `allowRoomInvites` BOOLEAN NOT NULL DEFAULT true,
    `tableTheme` VARCHAR(32) NOT NULL DEFAULT 'classic_green',
    `preferences` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `refreshTokenHash` VARCHAR(128) NOT NULL,
    `userAgent` VARCHAR(255) NULL,
    `ip` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUsedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,

    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OtpVerification` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NULL,
    `target` VARCHAR(254) NOT NULL,
    `purpose` ENUM('REGISTER', 'LOGIN', 'RESET_PASSWORD') NOT NULL,
    `codeHash` VARCHAR(128) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OtpVerification_target_purpose_createdAt_idx`(`target`, `purpose`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DeviceToken` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `token` VARCHAR(512) NOT NULL,
    `platform` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DeviceToken_token_key`(`token`),
    INDEX `DeviceToken_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GameCategory` (
    `id` CHAR(36) NOT NULL,
    `slug` VARCHAR(40) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `GameCategory_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Game` (
    `id` CHAR(36) NOT NULL,
    `code` ENUM('TEEN_PATTI', 'POKER', 'OMAHA', 'RUMMY', 'ANDAR_BAHAR', 'BACCARAT', 'GOLD_MINES') NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `tagline` VARCHAR(120) NOT NULL,
    `description` TEXT NOT NULL,
    `categoryId` CHAR(36) NULL,
    `minPlayers` INTEGER NOT NULL,
    `maxPlayers` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isFeatured` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `config` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Game_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Room` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(8) NOT NULL,
    `gameId` CHAR(36) NOT NULL,
    `hostId` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `visibility` ENUM('PUBLIC', 'PRIVATE') NOT NULL DEFAULT 'PUBLIC',
    `passwordHash` VARCHAR(255) NULL,
    `associationId` CHAR(36) NULL,
    `maxPlayers` INTEGER NOT NULL,
    `status` ENUM('WAITING', 'PLAYING', 'CLOSED') NOT NULL DEFAULT 'WAITING',
    `config` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Room_code_key`(`code`),
    INDEX `Room_status_visibility_idx`(`status`, `visibility`),
    INDEX `Room_gameId_status_idx`(`gameId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RoomPlayer` (
    `id` CHAR(36) NOT NULL,
    `roomId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `seat` INTEGER NOT NULL,
    `stack` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('SEATED', 'LEFT', 'KICKED') NOT NULL DEFAULT 'SEATED',
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `leftAt` DATETIME(3) NULL,

    INDEX `RoomPlayer_userId_status_idx`(`userId`, `status`),
    UNIQUE INDEX `RoomPlayer_roomId_userId_key`(`roomId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GameSession` (
    `id` CHAR(36) NOT NULL,
    `roomId` CHAR(36) NOT NULL,
    `gameId` CHAR(36) NOT NULL,
    `handNumber` INTEGER NOT NULL,
    `status` ENUM('IN_PROGRESS', 'COMPLETED', 'ABORTED') NOT NULL DEFAULT 'IN_PROGRESS',
    `seedCommit` VARCHAR(64) NOT NULL,
    `seedReveal` VARCHAR(64) NULL,
    `stateVersion` INTEGER NOT NULL DEFAULT 0,
    `summary` JSON NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,

    INDEX `GameSession_gameId_startedAt_idx`(`gameId`, `startedAt`),
    UNIQUE INDEX `GameSession_roomId_handNumber_key`(`roomId`, `handNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GameEvent` (
    `id` CHAR(36) NOT NULL,
    `gameSessionId` CHAR(36) NOT NULL,
    `seq` INTEGER NOT NULL,
    `type` VARCHAR(48) NOT NULL,
    `actorId` CHAR(36) NULL,
    `payload` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `GameEvent_gameSessionId_seq_key`(`gameSessionId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GameHistory` (
    `id` CHAR(36) NOT NULL,
    `gameSessionId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `gameId` CHAR(36) NOT NULL,
    `outcome` ENUM('WIN', 'LOSS', 'DRAW', 'FOLD') NOT NULL,
    `pointsDelta` INTEGER NOT NULL,
    `rank` INTEGER NULL,
    `details` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GameHistory_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `GameHistory_gameId_createdAt_idx`(`gameId`, `createdAt`),
    UNIQUE INDEX `GameHistory_gameSessionId_userId_key`(`gameSessionId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Association` (
    `id` CHAR(36) NOT NULL,
    `publicId` VARCHAR(16) NOT NULL,
    `name` VARCHAR(48) NOT NULL,
    `description` VARCHAR(500) NULL,
    `avatarUrl` VARCHAR(512) NULL,
    `emblem` VARCHAR(32) NOT NULL DEFAULT 'crown',
    `visibility` ENUM('PUBLIC', 'PRIVATE') NOT NULL DEFAULT 'PUBLIC',
    `joinPolicy` ENUM('OPEN', 'APPROVAL', 'INVITE_ONLY') NOT NULL DEFAULT 'APPROVAL',
    `ownerId` CHAR(36) NOT NULL,
    `maxMembers` INTEGER NOT NULL DEFAULT 200,
    `memberCount` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Association_publicId_key`(`publicId`),
    INDEX `Association_visibility_memberCount_idx`(`visibility`, `memberCount`),
    INDEX `Association_name_idx`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AssociationMember` (
    `associationId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `status` ENUM('ACTIVE', 'PENDING', 'BANNED') NOT NULL DEFAULT 'ACTIVE',
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastActiveAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AssociationMember_userId_status_idx`(`userId`, `status`),
    PRIMARY KEY (`associationId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AssociationInvitation` (
    `id` CHAR(36) NOT NULL,
    `associationId` CHAR(36) NOT NULL,
    `inviterId` CHAR(36) NOT NULL,
    `inviteeId` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `respondedAt` DATETIME(3) NULL,

    INDEX `AssociationInvitation_inviteeId_status_idx`(`inviteeId`, `status`),
    INDEX `AssociationInvitation_associationId_status_idx`(`associationId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Friendship` (
    `userAId` CHAR(36) NOT NULL,
    `userBId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Friendship_userBId_idx`(`userBId`),
    PRIMARY KEY (`userAId`, `userBId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FriendRequest` (
    `id` CHAR(36) NOT NULL,
    `senderId` CHAR(36) NOT NULL,
    `receiverId` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `respondedAt` DATETIME(3) NULL,

    INDEX `FriendRequest_receiverId_status_idx`(`receiverId`, `status`),
    INDEX `FriendRequest_senderId_status_idx`(`senderId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserBlock` (
    `blockerId` CHAR(36) NOT NULL,
    `blockedId` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`blockerId`, `blockedId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserReport` (
    `id` CHAR(36) NOT NULL,
    `reporterId` CHAR(36) NOT NULL,
    `reportedId` CHAR(36) NOT NULL,
    `reason` VARCHAR(40) NOT NULL,
    `details` VARCHAR(1000) NULL,
    `messageId` CHAR(36) NULL,
    `status` ENUM('OPEN', 'REVIEWING', 'ACTIONED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `resolution` VARCHAR(500) NULL,
    `handledById` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UserReport_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChatRoom` (
    `id` CHAR(36) NOT NULL,
    `type` ENUM('DIRECT', 'GROUP', 'ASSOCIATION', 'GAME_ROOM') NOT NULL,
    `name` VARCHAR(60) NULL,
    `directKey` VARCHAR(80) NULL,
    `associationId` CHAR(36) NULL,
    `gameRoomId` CHAR(36) NULL,
    `createdById` CHAR(36) NULL,
    `lastMessageAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ChatRoom_directKey_key`(`directKey`),
    UNIQUE INDEX `ChatRoom_associationId_key`(`associationId`),
    UNIQUE INDEX `ChatRoom_gameRoomId_key`(`gameRoomId`),
    INDEX `ChatRoom_type_lastMessageAt_idx`(`type`, `lastMessageAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ChatMember` (
    `chatRoomId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `isAdmin` BOOLEAN NOT NULL DEFAULT false,
    `lastReadAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `mutedUntil` DATETIME(3) NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ChatMember_userId_idx`(`userId`),
    PRIMARY KEY (`chatRoomId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Message` (
    `id` CHAR(36) NOT NULL,
    `chatRoomId` CHAR(36) NOT NULL,
    `senderId` CHAR(36) NULL,
    `type` ENUM('TEXT', 'GIFT', 'SYSTEM') NOT NULL DEFAULT 'TEXT',
    `content` VARCHAR(2000) NOT NULL,
    `meta` JSON NULL,
    `clientMsgId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,
    `deletedBy` CHAR(36) NULL,

    INDEX `Message_chatRoomId_createdAt_idx`(`chatRoomId`, `createdAt`),
    UNIQUE INDEX `Message_senderId_clientMsgId_key`(`senderId`, `clientMsgId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `type` VARCHAR(40) NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `body` VARCHAR(500) NOT NULL,
    `data` JSON NOT NULL,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Notification_userId_readAt_createdAt_idx`(`userId`, `readAt`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BroadcastNotification` (
    `id` CHAR(36) NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `body` VARCHAR(500) NOT NULL,
    `audience` VARCHAR(32) NOT NULL DEFAULT 'ALL',
    `sentCount` INTEGER NOT NULL DEFAULT 0,
    `createdById` CHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Gift` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `icon` VARCHAR(64) NOT NULL,
    `animation` VARCHAR(32) NOT NULL DEFAULT 'float',
    `pricePoints` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Gift_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GiftTransaction` (
    `id` CHAR(36) NOT NULL,
    `giftId` CHAR(36) NOT NULL,
    `senderId` CHAR(36) NOT NULL,
    `receiverId` CHAR(36) NOT NULL,
    `roomId` CHAR(36) NULL,
    `pointsSpent` INTEGER NOT NULL,
    `message` VARCHAR(140) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GiftTransaction_receiverId_createdAt_idx`(`receiverId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Achievement` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `description` VARCHAR(200) NOT NULL,
    `icon` VARCHAR(64) NOT NULL,
    `metric` VARCHAR(40) NOT NULL,
    `threshold` INTEGER NOT NULL,
    `gameCode` ENUM('TEEN_PATTI', 'POKER', 'OMAHA', 'RUMMY', 'ANDAR_BAHAR', 'BACCARAT', 'GOLD_MINES') NULL,
    `rewardPoints` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `Achievement_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserAchievement` (
    `userId` CHAR(36) NOT NULL,
    `achievementId` CHAR(36) NOT NULL,
    `unlockedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`userId`, `achievementId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LeaderboardEntry` (
    `id` CHAR(36) NOT NULL,
    `period` ENUM('WEEKLY', 'MONTHLY', 'ALL_TIME') NOT NULL,
    `periodKey` VARCHAR(16) NOT NULL,
    `scope` VARCHAR(16) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `score` INTEGER NOT NULL DEFAULT 0,
    `wins` INTEGER NOT NULL DEFAULT 0,
    `played` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LeaderboardEntry_period_periodKey_scope_score_idx`(`period`, `periodKey`, `scope`, `score`),
    UNIQUE INDEX `LeaderboardEntry_period_periodKey_scope_userId_key`(`period`, `periodKey`, `scope`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PointsLedger` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `type` ENUM('SIGNUP_BONUS', 'DAILY_REWARD', 'TABLE_BUY_IN', 'TABLE_RETURN', 'GAME_WIN', 'GAME_LOSS', 'GIFT_SENT', 'ACHIEVEMENT_REWARD', 'ADMIN_ADJUSTMENT') NOT NULL,
    `amount` INTEGER NOT NULL,
    `balanceAfter` INTEGER NOT NULL,
    `refType` VARCHAR(32) NULL,
    `refId` VARCHAR(64) NULL,
    `idempotencyKey` VARCHAR(128) NOT NULL,
    `note` VARCHAR(200) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PointsLedger_idempotencyKey_key`(`idempotencyKey`),
    INDEX `PointsLedger_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyRewardClaim` (
    `userId` CHAR(36) NOT NULL,
    `day` VARCHAR(10) NOT NULL,
    `streak` INTEGER NOT NULL,
    `points` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`userId`, `day`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SupportTicket` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `subject` VARCHAR(120) NOT NULL,
    `category` VARCHAR(32) NOT NULL,
    `status` ENUM('OPEN', 'IN_PROGRESS', 'WAITING_USER', 'RESOLVED', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    `assignedToId` CHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SupportTicket_status_updatedAt_idx`(`status`, `updatedAt`),
    INDEX `SupportTicket_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SupportMessage` (
    `id` CHAR(36) NOT NULL,
    `ticketId` CHAR(36) NOT NULL,
    `authorId` CHAR(36) NOT NULL,
    `fromStaff` BOOLEAN NOT NULL DEFAULT false,
    `body` VARCHAR(4000) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SupportMessage_ticketId_createdAt_idx`(`ticketId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminUser` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `roleId` CHAR(36) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AdminUser_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminRole` (
    `id` CHAR(36) NOT NULL,
    `key` VARCHAR(32) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `description` VARCHAR(200) NULL,
    `isSystem` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AdminRole_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminPermission` (
    `id` CHAR(36) NOT NULL,
    `key` VARCHAR(48) NOT NULL,
    `description` VARCHAR(200) NULL,

    UNIQUE INDEX `AdminPermission_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminRolePermission` (
    `roleId` CHAR(36) NOT NULL,
    `permissionId` CHAR(36) NOT NULL,

    PRIMARY KEY (`roleId`, `permissionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminSession` (
    `id` CHAR(36) NOT NULL,
    `adminId` CHAR(36) NOT NULL,
    `tokenHash` VARCHAR(128) NOT NULL,
    `csrfToken` VARCHAR(64) NOT NULL,
    `ip` VARCHAR(64) NULL,
    `userAgent` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,

    UNIQUE INDEX `AdminSession_tokenHash_key`(`tokenHash`),
    INDEX `AdminSession_adminId_idx`(`adminId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` CHAR(36) NOT NULL,
    `actorType` ENUM('USER', 'ADMIN', 'SYSTEM') NOT NULL,
    `actorId` CHAR(36) NULL,
    `action` VARCHAR(64) NOT NULL,
    `targetType` VARCHAR(32) NULL,
    `targetId` VARCHAR(64) NULL,
    `metadata` JSON NOT NULL,
    `ip` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_actorType_actorId_createdAt_idx`(`actorType`, `actorId`, `createdAt`),
    INDEX `AuditLog_targetType_targetId_idx`(`targetType`, `targetId`),
    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SystemSetting` (
    `key` VARCHAR(64) NOT NULL,
    `value` JSON NOT NULL,
    `description` VARCHAR(200) NULL,
    `updatedById` CHAR(36) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Banner` (
    `id` CHAR(36) NOT NULL,
    `title` VARCHAR(80) NOT NULL,
    `subtitle` VARCHAR(160) NULL,
    `imageUrl` VARCHAR(512) NULL,
    `linkUrl` VARCHAR(255) NULL,
    `theme` VARCHAR(24) NOT NULL DEFAULT 'gold',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Profile` ADD CONSTRAINT `Profile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OtpVerification` ADD CONSTRAINT `OtpVerification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeviceToken` ADD CONSTRAINT `DeviceToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Game` ADD CONSTRAINT `Game_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `GameCategory`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Room` ADD CONSTRAINT `Room_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `Game`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Room` ADD CONSTRAINT `Room_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Room` ADD CONSTRAINT `Room_associationId_fkey` FOREIGN KEY (`associationId`) REFERENCES `Association`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RoomPlayer` ADD CONSTRAINT `RoomPlayer_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `Room`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RoomPlayer` ADD CONSTRAINT `RoomPlayer_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GameSession` ADD CONSTRAINT `GameSession_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `Room`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GameSession` ADD CONSTRAINT `GameSession_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `Game`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GameEvent` ADD CONSTRAINT `GameEvent_gameSessionId_fkey` FOREIGN KEY (`gameSessionId`) REFERENCES `GameSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GameHistory` ADD CONSTRAINT `GameHistory_gameSessionId_fkey` FOREIGN KEY (`gameSessionId`) REFERENCES `GameSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GameHistory` ADD CONSTRAINT `GameHistory_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GameHistory` ADD CONSTRAINT `GameHistory_gameId_fkey` FOREIGN KEY (`gameId`) REFERENCES `Game`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Association` ADD CONSTRAINT `Association_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssociationMember` ADD CONSTRAINT `AssociationMember_associationId_fkey` FOREIGN KEY (`associationId`) REFERENCES `Association`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssociationMember` ADD CONSTRAINT `AssociationMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssociationInvitation` ADD CONSTRAINT `AssociationInvitation_associationId_fkey` FOREIGN KEY (`associationId`) REFERENCES `Association`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssociationInvitation` ADD CONSTRAINT `AssociationInvitation_inviterId_fkey` FOREIGN KEY (`inviterId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssociationInvitation` ADD CONSTRAINT `AssociationInvitation_inviteeId_fkey` FOREIGN KEY (`inviteeId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Friendship` ADD CONSTRAINT `Friendship_userAId_fkey` FOREIGN KEY (`userAId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Friendship` ADD CONSTRAINT `Friendship_userBId_fkey` FOREIGN KEY (`userBId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FriendRequest` ADD CONSTRAINT `FriendRequest_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FriendRequest` ADD CONSTRAINT `FriendRequest_receiverId_fkey` FOREIGN KEY (`receiverId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserBlock` ADD CONSTRAINT `UserBlock_blockerId_fkey` FOREIGN KEY (`blockerId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserBlock` ADD CONSTRAINT `UserBlock_blockedId_fkey` FOREIGN KEY (`blockedId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserReport` ADD CONSTRAINT `UserReport_reporterId_fkey` FOREIGN KEY (`reporterId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserReport` ADD CONSTRAINT `UserReport_reportedId_fkey` FOREIGN KEY (`reportedId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserReport` ADD CONSTRAINT `UserReport_handledById_fkey` FOREIGN KEY (`handledById`) REFERENCES `AdminUser`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChatRoom` ADD CONSTRAINT `ChatRoom_associationId_fkey` FOREIGN KEY (`associationId`) REFERENCES `Association`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChatRoom` ADD CONSTRAINT `ChatRoom_gameRoomId_fkey` FOREIGN KEY (`gameRoomId`) REFERENCES `Room`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChatMember` ADD CONSTRAINT `ChatMember_chatRoomId_fkey` FOREIGN KEY (`chatRoomId`) REFERENCES `ChatRoom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ChatMember` ADD CONSTRAINT `ChatMember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_chatRoomId_fkey` FOREIGN KEY (`chatRoomId`) REFERENCES `ChatRoom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Message` ADD CONSTRAINT `Message_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BroadcastNotification` ADD CONSTRAINT `BroadcastNotification_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `AdminUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GiftTransaction` ADD CONSTRAINT `GiftTransaction_giftId_fkey` FOREIGN KEY (`giftId`) REFERENCES `Gift`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GiftTransaction` ADD CONSTRAINT `GiftTransaction_senderId_fkey` FOREIGN KEY (`senderId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GiftTransaction` ADD CONSTRAINT `GiftTransaction_receiverId_fkey` FOREIGN KEY (`receiverId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserAchievement` ADD CONSTRAINT `UserAchievement_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserAchievement` ADD CONSTRAINT `UserAchievement_achievementId_fkey` FOREIGN KEY (`achievementId`) REFERENCES `Achievement`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LeaderboardEntry` ADD CONSTRAINT `LeaderboardEntry_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PointsLedger` ADD CONSTRAINT `PointsLedger_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DailyRewardClaim` ADD CONSTRAINT `DailyRewardClaim_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupportTicket` ADD CONSTRAINT `SupportTicket_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupportTicket` ADD CONSTRAINT `SupportTicket_assignedToId_fkey` FOREIGN KEY (`assignedToId`) REFERENCES `AdminUser`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupportMessage` ADD CONSTRAINT `SupportMessage_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `SupportTicket`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminUser` ADD CONSTRAINT `AdminUser_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `AdminRole`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminRolePermission` ADD CONSTRAINT `AdminRolePermission_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `AdminRole`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminRolePermission` ADD CONSTRAINT `AdminRolePermission_permissionId_fkey` FOREIGN KEY (`permissionId`) REFERENCES `AdminPermission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminSession` ADD CONSTRAINT `AdminSession_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `AdminUser`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
