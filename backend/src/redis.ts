import { createClient } from 'redis';
import { config } from './config';

export const redis = createClient({ url: config.REDIS_URL });
redis.on('error', (error) => console.error('Redis error', error));