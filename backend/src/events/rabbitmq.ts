import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { rabbitConfig } from '../rabbit-config';
import type { OutboxEvent } from '../orders/repository';

export const ORDER_EVENTS_QUEUE = 'minicart.order-events';

export async function connectRabbit(): Promise<{ connection: ChannelModel; channel: ConfirmChannel }> {
  const connection = await amqp.connect(rabbitConfig.RABBITMQ_URL);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(rabbitConfig.RABBITMQ_EXCHANGE, 'topic', { durable: true });
  await channel.assertQueue(ORDER_EVENTS_QUEUE, { durable: true });
  await channel.bindQueue(ORDER_EVENTS_QUEUE, rabbitConfig.RABBITMQ_EXCHANGE, 'order.*');
  return { connection, channel };
}

export function publishOutboxEvent(channel: ConfirmChannel, event: OutboxEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.publish(
      rabbitConfig.RABBITMQ_EXCHANGE,
      event.eventType,
      Buffer.from(JSON.stringify({ id: event.id, type: event.eventType, aggregateId: event.aggregateId, payload: event.payload })),
      { persistent: true, contentType: 'application/json', messageId: event.id },
      (error) => error ? reject(error) : resolve()
    );
  });
}