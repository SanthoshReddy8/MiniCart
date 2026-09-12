import type { Pool } from 'pg';

export type SortMode = 'price_asc' | 'price_desc' | 'name_asc' | 'newest' | 'relevance';
export type Product = {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  description: string;
  price: number;
  stockQuantity: number;
  createdAt: string;
  updatedAt: string;
};
export type ProductFilters = { q?: string; category?: string; categoryId?: string; minPrice?: number; maxPrice?: number; sort: SortMode; limit: number; page?: number; cursor?: string };

type Cursor = { value: string | number; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): Cursor {
  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || !('value' in parsed) || !('id' in parsed) || typeof parsed.id !== 'string' || (typeof parsed.value !== 'string' && typeof parsed.value !== 'number')) {
    throw new Error('Invalid cursor');
  }
  return parsed as Cursor;
}

export class CatalogRepository {
  constructor(private readonly db: Pool) {}

  async listProducts(filters: ProductFilters): Promise<{ products: Product[]; nextCursor?: string }> {
    const values: Array<string | number> = [];
    const where: string[] = [];
    const add = (value: string | number): string => { values.push(value); return `$${values.length}`; };
    const searchQuery = filters.q ? add(filters.q) : undefined;
    if (searchQuery) where.push(`p.search_vector @@ websearch_to_tsquery('english', ${searchQuery})`);
    if (filters.categoryId) where.push(`p.category_id = ${add(filters.categoryId)}`);
    if (filters.category) {
      const category = add(filters.category);
      where.push(`(p.category_id::text = ${category} OR LOWER(c.name) = LOWER(${category}))`);
    }
    if (filters.minPrice !== undefined) where.push(`p.price >= ${add(filters.minPrice)}`);
    if (filters.maxPrice !== undefined) where.push(`p.price <= ${add(filters.maxPrice)}`);

    const cursor = filters.cursor ? decodeCursor(filters.cursor) : undefined;
    const sortExpression = filters.sort === 'name_asc' ? 'LOWER(p.name)' : filters.sort === 'newest' ? 'p.created_at' : filters.sort === 'relevance' ? `ts_rank(p.search_vector, websearch_to_tsquery('english', ${searchQuery}))` : 'p.price';
    const direction = filters.sort === 'price_desc' || filters.sort === 'newest' || filters.sort === 'relevance' ? 'DESC' : 'ASC';
    if (cursor) {
      const operator = direction === 'ASC' ? '>' : '<';
      where.push(`(${sortExpression}, p.id) ${operator} (${add(cursor.value)}, ${add(cursor.id)})`);
    }

    const limit = filters.limit + 1;
    values.push(limit);
    const limitPlaceholder = `$${values.length}`;
    const pagination = filters.page === undefined ? `LIMIT ${limitPlaceholder}` : (() => {
      values.push((filters.page - 1) * filters.limit);
      return `LIMIT ${limitPlaceholder} OFFSET $${values.length}`;
    })();
    const query = `
            SELECT p.id, p.category_id, c.name AS category_name, p.name, p.description, p.price,
              p.stock_quantity, p.created_at, p.updated_at,
              ${filters.sort === 'relevance' ? `${sortExpression} AS search_rank` : 'NULL AS search_rank'}
      FROM products p
      JOIN categories c ON c.id = p.category_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${sortExpression} ${direction}, p.id ${direction}
      ${pagination}`;
    const result = await this.db.query(query, values);
    const hasMore = result.rows.length > filters.limit;
    const mappedRows = (hasMore ? result.rows.slice(0, filters.limit) : result.rows).map((row) => ({
      id: row.id, categoryId: row.category_id, categoryName: row.category_name, name: row.name,
      description: row.description, price: Number(row.price), stockQuantity: row.stock_quantity,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), searchRank: row.search_rank === null ? undefined : Number(row.search_rank)
    }));
    const last = mappedRows[mappedRows.length - 1];
    const cursorValue = last && (filters.sort === 'name_asc' ? last.name.toLowerCase() : filters.sort === 'newest' ? last.createdAt : filters.sort === 'relevance' ? last.searchRank! : last.price);
    const products = mappedRows.map(({ searchRank: _searchRank, ...product }) => product);
    return { products, ...(hasMore && last ? { nextCursor: encodeCursor({ value: cursorValue, id: last.id }) } : {}) };
  }

  async createCategory(name: string): Promise<{ id: string; name: string }> {
    const result = await this.db.query('INSERT INTO categories (name) VALUES ($1) RETURNING id, name', [name]);
    return result.rows[0];
  }

  async getProduct(id: string): Promise<Product | null> {
    const result = await this.db.query(
      `SELECT p.id, p.category_id, c.name AS category_name, p.name, p.description, p.price,
              p.stock_quantity, p.created_at, p.updated_at
       FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = $1`, [id]
    );
    const row = result.rows[0];
    return row ? { id: row.id, categoryId: row.category_id, categoryName: row.category_name, name: row.name,
      description: row.description, price: Number(row.price), stockQuantity: row.stock_quantity,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() } : null;
  }

  async createProduct(input: { categoryId: string; name: string; description: string; price: number; stockQuantity: number }): Promise<{ id: string }> {
    const result = await this.db.query(
      `INSERT INTO products (category_id, name, description, price, stock_quantity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, category_id, name, description, price, stock_quantity, created_at, updated_at`,
      [input.categoryId, input.name, input.description, input.price, input.stockQuantity]
    );
    return { id: result.rows[0].id };
  }

  async updateProduct(id: string, updates: { categoryId?: string; name?: string; description?: string; price?: number; stockQuantity?: number }): Promise<Product | null> {
    const values: Array<string | number> = [];
    const fields: string[] = [];
    if (updates.categoryId !== undefined) { values.push(updates.categoryId); fields.push(`category_id = $${values.length}`); }
    if (updates.name !== undefined) { values.push(updates.name); fields.push(`name = $${values.length}`); }
    if (updates.description !== undefined) { values.push(updates.description); fields.push(`description = $${values.length}`); }
    if (updates.price !== undefined) { values.push(updates.price); fields.push(`price = $${values.length}`); }
    if (updates.stockQuantity !== undefined) { values.push(updates.stockQuantity); fields.push(`stock_quantity = $${values.length}`); }
    if (!fields.length) return null;
    values.push(id);
    const result = await this.db.query(`UPDATE products SET ${fields.join(', ')}, version = version + 1, updated_at = NOW() WHERE id = $${values.length} RETURNING id`, values);
    return result.rowCount === 1 ? this.getProduct(result.rows[0].id) : null;
  }

  async deleteProduct(id: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM products WHERE id = $1', [id]);
    return result.rowCount === 1;
  }
}