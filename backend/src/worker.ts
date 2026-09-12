import type { ConsumeMessage } from 'amqplib';
import { connectRabbit, ORDER_EVENTS_QUEUE } from './events/rabbitmq';

async function handleOrderCreated(message: ConsumeMessage): Promise<void> {
  const event = JSON.parse(message.content.toString()) as { type: string; payload: { orderId: string; userId?: string; total?: number } };
  if (event.type === 'order.created') {
    console.log(`Order confirmation side effects queued for ${event.payload.orderId}`);
    console.log(`Analytics event: order.created total=${event.payload.total}`);
  }
  if (event.type === 'order.paid') {
    console.log(`Payment confirmation side effects queued for ${event.payload.orderId}`);
    console.log(`Analytics event: order.paid`);
  }
}

async function startWorker(): Promise<void> {
  const { connection, channel } = await connectRabbit();
  await channel.prefetch(10);
  await channel.consume(ORDER_EVENTS_QUEUE, async (message) => {
    if (!message) return;
    try {
      await handleOrderCreated(message);
      channel.ack(message);
    } catch (error) {
      console.error('Order event failed; requeueing', error);
      channel.nack(message, false, true);
    }
  });
  connection.on('error', (error) => console.error('RabbitMQ worker error', error));
  console.log('Order event worker listening');
}

startWorker().catch((error) => {
  console.error('Failed to start order event worker', error);
  process.exit(1);
});