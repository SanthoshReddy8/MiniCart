import { describe, expect, it } from 'vitest';
import { CatalogCache } from '../src/catalog/cache.js';
import { decodeCursor, encodeCursor } from '../src/catalog/repository.js';

describe('catalog cursors', () => {
  it('round-trips the sort value and stable product id', () => {
    const encoded = encodeCursor({ value: 12.5, id: 'product-1' });
    expect(decodeCursor(encoded)).toEqual({ value: 12.5, id: 'product-1' });
  });
});

describe('catalog cache', () => {
  it('changes the cache namespace when invalidated', async () => {
    let version = 0;
    const values = new Map<string, string>();
    const redis = {
      get: async (key: string) => key === 'catalog:products:version' ? String(version) : values.get(key) ?? null,
      set: async (key: string, value: string) => { values.set(key, value); },
      incr: async () => ++version
    };
    const cache = new CatalogCache(redis, 60);
    const filters = { sort: 'newest' as const, limit: 20 };
    await cache.set(filters, { products: [] });
    expect(await cache.get(filters)).toEqual({ products: [] });
    await cache.invalidate();
    expect(await cache.get(filters)).toBeNull();
  });
});