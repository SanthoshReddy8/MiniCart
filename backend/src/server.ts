import { createApp } from './app';
import { config } from './config';
import { pool } from './db';
import { redis } from './redis';

async function start(): Promise<void> {
  await redis.connect();
  const app = createApp(pool, redis);
  app.listen(config.PORT, () => console.log(`Auth service listening on port ${config.PORT}`));
}

start().catch((error) => {
  console.error('Failed to start auth service', error);
  process.exit(1);
});