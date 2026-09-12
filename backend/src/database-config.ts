import 'dotenv/config';
import { z } from 'zod';

export const databaseConfig = z.object({
  DATABASE_URL: z.string().url().default('postgres://minicart:minicart@localhost:5432/minicart')
}).parse(process.env);