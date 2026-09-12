import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import express, { type Express } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { AuthRepository } from './auth/repository';
import { createAccessToken, createRefreshToken, hashToken } from './auth/tokens';
import { config } from './config';
import { requireAuth, requireRole } from './middleware/auth';
import { rateLimit, resetRateLimit } from './middleware/rateLimit';
import { CatalogCache } from './catalog/cache';
import { CatalogRepository, type SortMode } from './catalog/repository';
import { CartError, CartRepository } from './cart/repository';
import { OrderError, OrderRepository, type OrderStatus } from './orders/repository';
import type { Pool } from 'pg';

type Redis = Parameters<typeof rateLimit>[0] & ConstructorParameters<typeof CatalogCache>[0];
const credentials = z.object({ email: z.string().email().transform((value) => value.toLowerCase()), password: z.string().min(8).max(128) });
const refreshBody = z.object({ refreshToken: z.string().min(32) });
const logoutBody = z.object({ refreshToken: z.string().min(32) });
const productQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  category: z.string().trim().min(1).optional(),
  categoryId: z.string().uuid().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  sort: z.enum(['price_asc', 'price_desc', 'name_asc', 'newest', 'relevance']).default('newest'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  page: z.coerce.number().int().min(1).optional(),
  cursor: z.string().optional()
}).refine((value) => value.minPrice === undefined || value.maxPrice === undefined || value.minPrice <= value.maxPrice, { message: 'minPrice must be less than maxPrice' })
  .refine((value) => value.page === undefined || value.cursor === undefined, { message: 'Use either page or cursor pagination' })
  .refine((value) => value.sort !== 'relevance' || value.q !== undefined, { message: 'relevance sorting requires q' });
const productInput = z.object({ categoryId: z.string().uuid(), name: z.string().trim().min(1).max(200), description: z.string().max(2000).default(''), price: z.number().nonnegative(), stockQuantity: z.number().int().nonnegative() });
const productUpdate = z.object({ categoryId: z.string().uuid().optional(), name: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(), price: z.number().nonnegative().optional(), stockQuantity: z.number().int().nonnegative().optional() }).refine((value) => Object.keys(value).length > 0);
const categoryInput = z.object({ name: z.string().trim().min(1).max(100) });
const cartQuantity = z.object({ quantity: z.number().int().min(1).max(1000) });
const productId = z.string().uuid();
const orderStatus = z.enum(['paid', 'shipped', 'delivered', 'cancelled']);
const orderId = z.string().uuid();

function publicUser(user: { id: string; email: string; role: string }) {
  return { id: user.id, email: user.email, role: user.role };
}

export function createApp(pool: Pool, redis: Redis): Express {
  const app = express();
  const repository = new AuthRepository(pool);
  const catalogRepository = new CatalogRepository(pool);
  const catalogCache = new CatalogCache(redis);
  const cartRepository = new CartRepository(pool);
  const orderRepository = new OrderRepository(pool);
  const stripe = new Stripe(config.STRIPE_SECRET_KEY);

  app.post(['/payments/stripe/webhook', '/api/payments/webhook'], express.raw({ type: 'application/json' }), async (request, response) => {
    const signature = request.header('stripe-signature');
    if (!signature) { response.status(400).send('Missing Stripe signature'); return; }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(request.body as Buffer, signature, config.STRIPE_WEBHOOK_SECRET);
    } catch {
      response.status(400).send('Invalid Stripe signature');
      return;
    }
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const orderId = paymentIntent.metadata.orderId ?? paymentIntent.metadata.order_id;
      if (orderId) await orderRepository.markPaidFromStripeWebhook(event.id, paymentIntent.id, orderId);
    }
    if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      const orderId = paymentIntent.metadata.orderId ?? paymentIntent.metadata.order_id;
      await orderRepository.markPaymentFailedFromStripeWebhook(event.id, paymentIntent.id, orderId);
    }
    response.json({ received: true });
  });

  app.use(express.json());

  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  app.get(['/products', '/api/products'], async (request, response) => {
    const parsed = productQuery.safeParse(request.query);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid product filters' }); return; }
    const startedAt = Date.now();
    try {
      const filters = parsed.data as { q?: string; category?: string; categoryId?: string; minPrice?: number; maxPrice?: number; sort: SortMode; limit: number; page?: number; cursor?: string };
      const cached = await catalogCache.get(filters);
      if (cached) {
        console.log(`CACHE HIT: ${Date.now() - startedAt}ms`);
        response.setHeader('X-Cache', 'HIT'); response.json(cached); return;
      }
      const listing = await catalogRepository.listProducts(filters);
      await catalogCache.set(filters, listing);
      console.log(`CACHE MISS (DB query): ${Date.now() - startedAt}ms`);
      response.setHeader('X-Cache', 'MISS');
      response.json(listing);
    } catch {
      response.status(400).json({ error: 'Invalid product cursor or filters' });
    }
  });

  app.post(['/auth/signup', '/api/auth/signup'], rateLimit(redis, { windowSeconds: 60, max: 5, prefix: 'auth:signup' }), async (request, response) => {
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid credentials' }); return; }
    try {
      const passwordHash = await bcrypt.hash(parsed.data.password, config.BCRYPT_ROUNDS);
      const user = await repository.createUser(parsed.data.email, passwordHash);
      const refresh = createRefreshToken();
      await repository.saveRefreshToken(user.id, refresh.hash, refresh.expiresAt);
      response.status(201).json({ user: publicUser(user), accessToken: createAccessToken(user), refreshToken: refresh.raw });
    } catch (error: unknown) {
      if ((error as { code?: string }).code === '23505') { response.status(409).json({ error: 'Email already registered' }); return; }
      response.status(500).json({ error: 'Unable to create account' });
    }
  });

  app.post(['/auth/login', '/api/auth/login'], rateLimit(redis, { windowSeconds: 60, max: 5, prefix: 'auth:login', keySource: 'email-or-ip' }), async (request, response) => {
    const parsed = credentials.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid credentials' }); return; }
    const user = await repository.findUserByEmail(parsed.data.email);
    const valid = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid');
    if (!user || !valid) { response.status(401).json({ error: 'Invalid email or password' }); return; }
    await resetRateLimit(redis, request, { windowSeconds: 60, max: 5, prefix: 'auth:login', keySource: 'email-or-ip' });
    const refresh = createRefreshToken();
    await repository.saveRefreshToken(user.id, refresh.hash, refresh.expiresAt);
    response.json({ user: publicUser(user), accessToken: createAccessToken(user), refreshToken: refresh.raw });
  });

  app.post(['/auth/refresh', '/api/auth/refresh'], async (request, response) => {
    const parsed = refreshBody.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid refresh token' }); return; }
    const refresh = createRefreshToken();
    const user = await repository.rotateRefreshToken(hashToken(parsed.data.refreshToken), { hash: refresh.hash, expiresAt: refresh.expiresAt });
    if (!user) { response.status(401).json({ error: 'Invalid or expired refresh token' }); return; }
    response.json({ user: publicUser(user), accessToken: createAccessToken(user), refreshToken: refresh.raw });
  });

  app.post(['/auth/logout', '/api/auth/logout'], requireAuth, async (request, response) => {
    const parsed = logoutBody.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid refresh token' }); return; }
    await repository.revokeRefreshToken(request.auth!.sub, hashToken(parsed.data.refreshToken));
    response.status(204).send();
  });

  app.get('/auth/me', requireAuth, (request, response) => response.json({ user: request.auth }));
  app.get('/admin/health', requireAuth, requireRole('admin'), (_request, response) => response.json({ status: 'admin ok' }));

  app.post(['/categories', '/api/categories'], requireAuth, requireRole('admin'), async (request, response) => {
    const parsed = categoryInput.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid category' }); return; }
    try { response.status(201).json(await catalogRepository.createCategory(parsed.data.name)); }
    catch { response.status(409).json({ error: 'Category already exists' }); }
  });

  app.post(['/products', '/api/products'], requireAuth, requireRole('admin'), async (request, response) => {
    const parsed = productInput.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid product' }); return; }
    try {
      const product = await catalogRepository.createProduct(parsed.data);
      await catalogCache.invalidate();
      response.status(201).json(product);
    } catch { response.status(400).json({ error: 'Unable to create product' }); }
  });

  app.get(['/products/:id', '/api/products/:id'], async (request, response) => {
    const parsedId = productId.safeParse(request.params.id);
    if (!parsedId.success) { response.status(400).json({ error: 'Invalid product id' }); return; }
    const product = await catalogRepository.getProduct(parsedId.data);
    if (!product) { response.status(404).json({ error: 'Product not found' }); return; }
    response.json(product);
  });

  app.put(['/products/:id', '/api/products/:id'], requireAuth, requireRole('admin'), async (request, response) => {
    const parsed = productUpdate.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid product update' }); return; }
    try {
      const updated = await catalogRepository.updateProduct(String(request.params.id), parsed.data);
      if (!updated) { response.status(404).json({ error: 'Product not found' }); return; }
      await catalogCache.invalidate();
      response.json(updated);
    } catch { response.status(400).json({ error: 'Unable to update product' }); }
  });

  app.patch(['/products/:id', '/api/products/:id'], requireAuth, requireRole('admin'), async (request, response) => {
    const parsed = productUpdate.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid product update' }); return; }
    try {
      const updated = await catalogRepository.updateProduct(String(request.params.id), parsed.data);
      if (!updated) { response.status(404).json({ error: 'Product not found' }); return; }
      await catalogCache.invalidate();
      response.json(updated);
    } catch { response.status(400).json({ error: 'Unable to update product' }); }
  });

  app.delete(['/products/:id', '/api/products/:id'], requireAuth, requireRole('admin'), async (request, response) => {
    const removed = await catalogRepository.deleteProduct(String(request.params.id));
    if (!removed) { response.status(404).json({ error: 'Product not found' }); return; }
    await catalogCache.invalidate();
    response.status(204).send();
  });

  app.get(['/cart', '/api/cart'], requireAuth, async (request, response) => {
    response.json({ items: await cartRepository.getCart(request.auth!.sub) });
  });

  app.post(['/cart/items/:productId', '/api/cart/items/:productId'], requireAuth, async (request, response) => {
    const parsedProductId = productId.safeParse(request.params.productId);
    const parsedQuantity = cartQuantity.safeParse(request.body);
    if (!parsedProductId.success || !parsedQuantity.success) { response.status(400).json({ error: 'Invalid cart item' }); return; }
    try {
      await cartRepository.addItem(request.auth!.sub, parsedProductId.data, parsedQuantity.data.quantity);
      response.status(204).send();
    } catch (error) {
      if (error instanceof CartError) { response.status(error.status).json({ error: error.message, details: error.details }); return; }
      response.status(500).json({ error: 'Unable to update cart' });
    }
  });

  app.post(['/cart/items', '/api/cart/items'], requireAuth, async (request, response) => {
    const parsed = z.object({ productId, quantity: cartQuantity.shape.quantity }).safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ error: 'Invalid cart item' }); return; }
    try {
      await cartRepository.addItem(request.auth!.sub, parsed.data.productId, parsed.data.quantity);
      response.status(204).send();
    } catch (error) {
      if (error instanceof CartError) { response.status(error.status).json({ error: error.message, details: error.details }); return; }
      response.status(500).json({ error: 'Unable to update cart' });
    }
  });

  app.patch(['/cart/items/:productId', '/api/cart/items/:productId'], requireAuth, async (request, response) => {
    const parsedProductId = productId.safeParse(request.params.productId);
    const parsedQuantity = cartQuantity.safeParse(request.body);
    if (!parsedProductId.success || !parsedQuantity.success) { response.status(400).json({ error: 'Invalid cart item' }); return; }
    try {
      await cartRepository.updateItem(request.auth!.sub, parsedProductId.data, parsedQuantity.data.quantity);
      response.status(204).send();
    } catch (error) {
      if (error instanceof CartError) { response.status(error.status).json({ error: error.message, details: error.details }); return; }
      response.status(500).json({ error: 'Unable to update cart' });
    }
  });

  app.delete(['/cart/items/:productId', '/api/cart/items/:productId'], requireAuth, async (request, response) => {
    const parsedProductId = productId.safeParse(request.params.productId);
    if (!parsedProductId.success) { response.status(400).json({ error: 'Invalid product id' }); return; }
    const removed = await cartRepository.removeItem(request.auth!.sub, parsedProductId.data);
    if (!removed) { response.status(404).json({ error: 'Cart item not found' }); return; }
    response.status(204).send();
  });

  app.post('/cart/checkout/validate', requireAuth, async (request, response) => {
    const validation = await cartRepository.validateCheckout(request.auth!.sub);
    if (!validation.valid) { response.status(409).json(validation); return; }
    response.json(validation);
  });

  app.post(['/orders', '/api/orders'], requireAuth, async (request, response) => {
    const idempotencyKey = request.get('Idempotency-Key');
    if (!idempotencyKey || idempotencyKey.length > 128) { response.status(400).json({ error: 'Idempotency-Key header is required' }); return; }
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(request.body ?? {})).digest('hex');
    try {
      const result = await orderRepository.placeOrder(request.auth!.sub, idempotencyKey, requestHash);
      response.status(result.statusCode).json(result.body);
    } catch (error) {
      if (error instanceof OrderError) { response.status(error.status).json({ error: error.message, details: error.details }); return; }
      response.status(500).json({ error: 'Unable to place order' });
    }
  });

  app.get(['/orders', '/api/orders'], requireAuth, async (request, response) => {
    response.json({ orders: await orderRepository.listOrders(request.auth!.sub) });
  });

  app.get(['/orders/:id', '/api/orders/:id'], requireAuth, async (request, response) => {
    const parsedId = orderId.safeParse(request.params.id);
    if (!parsedId.success) { response.status(400).json({ error: 'Invalid order id' }); return; }
    const order = await orderRepository.getOrder(request.auth!.sub, parsedId.data);
    if (!order) { response.status(404).json({ error: 'Order not found' }); return; }
    response.json(order);
  });

  app.post('/orders/:id/payment-session', requireAuth, async (request, response) => {
    const parsedId = orderId.safeParse(request.params.id);
    if (!parsedId.success) { response.status(400).json({ error: 'Invalid order id' }); return; }
    const order = await orderRepository.getOrderForPayment(request.auth!.sub, parsedId.data);
    if (!order) { response.status(404).json({ error: 'Order not found' }); return; }
    if (order.status !== 'pending') { response.status(409).json({ error: 'Order is not payable' }); return; }
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: order.email,
        line_items: order.items.map((item) => ({
          quantity: item.quantity,
          price_data: { currency: 'usd', unit_amount: Math.round(item.price * 100), product_data: { name: item.name } }
        })),
        payment_intent_data: { metadata: { order_id: order.id } },
        success_url: config.STRIPE_SUCCESS_URL,
        cancel_url: config.STRIPE_CANCEL_URL,
        metadata: { order_id: order.id }
      });
      await orderRepository.saveCheckoutSession(order.id, session.id);
      response.json({ sessionId: session.id, checkoutUrl: session.url });
    } catch {
      response.status(502).json({ error: 'Unable to create payment session' });
    }
  });

  app.post(['/payments/create-intent', '/api/payments/create-intent'], requireAuth, async (request, response) => {
    const parsedId = orderId.safeParse(request.body?.orderId);
    if (!parsedId.success) { response.status(400).json({ error: 'orderId is required' }); return; }
    const order = await orderRepository.getOrderForPayment(request.auth!.sub, parsedId.data);
    if (!order) { response.status(404).json({ error: 'Order not found' }); return; }
    if (order.status !== 'pending') { response.status(409).json({ error: 'Order is not payable' }); return; }
    try {
      const intent = await stripe.paymentIntents.create({ amount: Math.round(order.total * 100), currency: 'usd', metadata: { orderId: order.id } });
      await orderRepository.savePaymentIntent(order.id, intent.id);
      response.json({ clientSecret: intent.client_secret, paymentIntentId: intent.id });
    } catch { response.status(502).json({ error: 'Unable to create payment intent' }); }
  });

  app.patch('/admin/orders/:id/status', requireAuth, requireRole('admin'), async (request, response) => {
    const parsedId = orderId.safeParse(request.params.id);
    const parsedStatus = orderStatus.safeParse(request.body?.status);
    if (!parsedId.success || !parsedStatus.success) { response.status(400).json({ error: 'Invalid order status update' }); return; }
    const transitioned = await orderRepository.transitionStatus(parsedId.data, parsedStatus.data as OrderStatus);
    if (!transitioned) { response.status(409).json({ error: 'Invalid order status transition' }); return; }
    response.status(204).send();
  });
  return app;
}