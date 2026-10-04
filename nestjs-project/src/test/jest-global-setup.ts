import { config } from 'dotenv';
import { resolve } from 'node:path';
import { Client } from 'pg';

// Runs once before the whole test run, before any setupFiles/test file.
// Creates the isolated test database if it doesn't exist yet — the app's
// migrations/synchronize logic then builds the schema inside it per-suite.
export default async function globalSetup(): Promise<void> {
  config({ path: resolve(__dirname, '../../.env') });
  config({ path: resolve(__dirname, '../../.env.test'), override: true });

  const testDatabase = process.env.DB_NAME ?? 'streamtube_test';

  const adminClient = new Client({
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: 'postgres',
  });

  await adminClient.connect();
  try {
    const { rows } = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [testDatabase],
    );
    if (rows.length === 0) {
      await adminClient.query(`CREATE DATABASE "${testDatabase}"`);
    }
  } finally {
    await adminClient.end();
  }
}
