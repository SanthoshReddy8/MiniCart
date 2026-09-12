import 'dotenv/config';
import { z } from 'zod';

export const rabbitConfig = z.object({
  RABBITMQ_URL: z.string().url().default('amqp://localhost:5672'),
  RABBITMQ_EXCHANGE: z.string().default('minicart.events')
}).parse(process.env);