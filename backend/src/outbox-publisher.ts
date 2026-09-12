import { pool } from './db';
import { connectRabbit, publishOutboxEvent } from './events/rabbitmq';
import { OrderRepository } from './orders/repository';

async function publishPending(): Promise<void> {
  const { connection, channel } = await connectRabbit();
  const orders = new OrderRepository(pool);
  try {
    const events = await orders.getPendingOutboxEvents(50);
    for (const event of events) {
      await publishOutboxEvent(channel, event);
      await orders.markOutboxPublished(event.id);
    }
  } finally {
    await channel.close();
    await connection.close();
  }
}

async function start(): Promise<void> {
  do {
    try {
      await publishPending();
    } catch (error) {
      console.error('Outbox publish failed; will retry', error);
      if ((error as { code?: string }).code === '42P01') {
        console.error('Database schema is missing. Run: npm run migrate');
        process.exit(1);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (true);
}

start().catch((error) => {
  console.error('Failed to start outbox publisher', error);
  process.exit(1);
});