import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db';

async function migrate(): Promise<void> {
  const directory = path.resolve(process.cwd(), 'sql');
  const files = (await fs.readdir(directory))
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    console.log(`Applying ${file}`);
    await pool.query(await fs.readFile(path.join(directory, file), 'utf8'));
  }
  await pool.end();
  console.log(`Applied ${files.length} migrations`);
}

migrate().catch(async (error) => {
  console.error('Migration failed', error);
  await pool.end();
  process.exit(1);
});