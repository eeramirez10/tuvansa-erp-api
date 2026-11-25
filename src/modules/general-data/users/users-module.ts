import { legacyUserDirectory } from './infrastructure/legacy-user-directory.js';
import { PostgresWebAccess } from './infrastructure/postgres-web-access.js';

export const webAccess = new PostgresWebAccess(legacyUserDirectory);
