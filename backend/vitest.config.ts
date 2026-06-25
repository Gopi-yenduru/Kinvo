import { defineConfig } from 'vitest/config';

// Tests run against a throwaway SQLite DB so they need no Docker/Postgres and
// are fully deterministic. Env is set here so it is in place before the data
// layer (which reads process.env at import time) is loaded.
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './test/globalSetup.ts',
    env: {
      DB_CLIENT: 'sqlite',
      SQLITE_PATH: './test/.tmp-test.sqlite',
      JWT_SECRET: 'test_jwt_secret_at_least_32_chars_long_xxxxx',
      JWT_EXPIRES_IN: '1h',
      ADMIN_PASSWORD: 'admin123',
      SARVAM_API_KEY: 'test_dummy_key',
      ENCRYPTION_KEY: 'test_encryption_key_for_phi_fields_xxx',
      NODE_ENV: 'test'
    },
    include: ['test/**/*.test.ts'],
    hookTimeout: 20000
  }
});
