import request from 'supertest';
import { createApp } from '../src/app.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

const productId = 47087;
const paths = [
  'actions/warehouses', 'actions/color-size-registration', 'actions/block-status',
  'actions/classifications', 'actions/extended-description',
  'actions/discounts/customers', 'actions/discounts/suppliers', 'actions/other-data',
  'actions/specifications', 'actions/photo', 'actions/ct-inventory', 'actions/prices',
  'actions/skus', 'actions/prepacks', 'purchases-production/alternates',
  'purchases-production/components', 'purchases-production/quality-specifications',
  'purchases-production/implosion', 'purchases-production/lots',
  'purchases-production/inventory-layers', 'queries/ledger', 'queries/customer-orders',
  'queries/customer-orders/star', 'queries/customer-orders/ct',
  'queries/customer-quotes', 'queries/customer-sales', 'queries/customer-sales/star',
  'queries/customer-sales/ct', 'queries/customer-sales/detail',
  'queries/sales/by-branch', 'queries/sales/annual', 'queries/sales/annual-summary',
  'queries/supplier-orders', 'queries/supplier-orders/ct', 'queries/supplier-quotes',
  'queries/supplier-purchases', 'queries/supplier-purchases/dt',
  'queries/supplier-purchases/detail', 'queries/purchases/annual',
  'queries/purchases/annual-summary', 'queries/pieces', 'queries/pieces/fulfilled',
  'queries/work-in-progress', 'queries/work-in-progress/ct', 'queries/edi',
  'queries/pending-enablements', 'queries/documents',
] as const;

try {
  const app = createApp();
  for (const path of paths) {
    const response = await request(app)
      .get(`/api/inventories/products/${productId}/${path}`)
      .query({ page: 1, pageSize: 2 });
    if (response.status !== 200) {
      throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(response.body)}`);
    }
    console.log(`${path}: ${String(response.body.data.available)} (${String(response.body.data.items.length)})`);
  }
  console.log(`Botones de Inventarios PT verificados: ${String(paths.length)} endpoints.`);
} finally {
  await legacyMysqlPool.end();
}
