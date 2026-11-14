# CS Card Station — Backend (API & server)

NestJS API + Socket.IO real-time server for CS Card Station.

Full documentation lives in the main README, **Part A**:
[requirements](../README.md#a1-requirements) ·
[setup](../README.md#a2-setup-step-by-step) ·
[environment variables](../README.md#a3-environment-variables) ·
[database](../README.md#a4-database-configuration) ·
[test data & credentials](../README.md#a5-test-data--credentials) ·
[REST endpoints](../README.md#a6-rest-api-endpoints) ·
[Socket.IO](../README.md#a7-real-time-api-socketio) ·
[testing](../README.md#a8-testing-the-backend) ·
[status](../README.md#a9-backend-status)

```bash
npm install && cp .env.example .env     # then fill DATABASE_URL (MySQL 8) and the 3 secrets
npx prisma migrate deploy && npm run db:seed && npm run db:seed:demo
npm run build && npm run start:prod     # http://localhost:3000 · Swagger at /api/docs
```
