import { devNull } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      DOTENV_CONFIG_PATH: devNull,
      NEON_DATABASE_URL: '',
      LEGACY_DB_HOST: '127.0.0.1',
      LEGACY_DB_PORT: '1',
      LEGACY_DB_USER: 'vitest',
      LEGACY_DB_PASSWORD: 'unused',
      LEGACY_DB_NAME: 'vitest',
      WEB_SESSION_ORIGIN: '',
      WEB_SESSION_CROSS_ORIGIN_PATH: '',
    },
  },
});
