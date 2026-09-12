import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  RABBITMQ_URL: z.string().url().default('amqp://localhost:5672'),
  RABBITMQ_EXCHANGE: z.string().default('minicart.events'),
  JWT_ACCESS_SECRET: z.string().min(32),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_SUCCESS_URL: z.string().url().default('http://localhost:3000/payment/success'),
  STRIPE_CANCEL_URL: z.string().url().default('http://localhost:3000/payment/cancel'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12)
});

export const config = schema.parse(process.env);