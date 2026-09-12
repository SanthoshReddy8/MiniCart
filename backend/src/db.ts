import { Pool } from 'pg';
import { databaseConfig } from './database-config';

export const pool = new Pool({ connectionString: databaseConfig.DATABASE_URL });