import crypto from 'node:crypto';
import type { Product, ProductFilters } from './repository';

type RedisCache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  incr(key: string): Promise<number>;
};
type Listing = { products: Product[]; nextCursor?: string };

export class CatalogCache {
  private readonly versionKey = 'catalog:products:version';
  constructor(private readonly redis: RedisCache, private readonly ttlSeconds = 300) {}

  async get(filters: ProductFilters): Promise<Listing | null> {
    const version = await this.redis.get(this.versionKey) ?? '0';
    const key = this.key(version, filters);
    const value = await this.redis.get(key);
    return value ? JSON.parse(value) as Listing : null;
  }

  async set(filters: ProductFilters, listing: Listing): Promise<void> {
    const version = await this.redis.get(this.versionKey) ?? '0';
    await this.redis.set(this.key(version, filters), JSON.stringify(listing), { EX: this.ttlSeconds });
  }

  async invalidate(): Promise<void> {
    await this.redis.incr(this.versionKey);
  }

  private key(version: string, filters: ProductFilters): string {
    const digest = crypto.createHash('sha256').update(JSON.stringify(filters)).digest('hex');
    return `catalog:products:v${version}:${digest}`;
  }
}