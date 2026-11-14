import * as fs from 'fs';
import * as path from 'path';

// Load backend/.env, then point every e2e test at a SEPARATE test database on the same server.
// The test database name is always explicit, so the tests can never touch the development data.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export const TEST_DATABASE_NAME = process.env.TEST_DATABASE_NAME ?? 'cs_card_station_test';

if (!process.env.TEST_DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.pathname.slice(1) === TEST_DATABASE_NAME) throw new Error('DATABASE_URL already points at the test database');
  // Keep the development URL so the test setup can create the test database if it is missing.
  process.env.ADMIN_DATABASE_URL = url.toString();
  url.pathname = `/${TEST_DATABASE_NAME}`;
  process.env.TEST_DATABASE_URL = url.toString();
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
