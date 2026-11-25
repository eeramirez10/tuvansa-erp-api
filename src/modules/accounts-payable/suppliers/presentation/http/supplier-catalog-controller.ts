import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { WriteSupplierCatalog } from '../../application/use-cases/write-supplier-catalog.js';
import type { SuppliersDataSource } from '../../domain/datasources/suppliers-data-source.js';

const text = (maximum: number) => z.string().trim().max(maximum);
const uppercase = (maximum: number) => z.string().trim().toUpperCase().max(maximum);
const discount = z.number().min(0).max(100).multipleOf(0.01);
const fields = z.strictObject({
  code: uppercase(6).min(1), name: text(80).min(1), notes: text(127),
  address: z.strictObject({ street: text(45), neighborhood: text(35), city: text(30), state: text(30), postalCode: text(7) }),
  contact: z.strictObject({ name: text(30), phone: text(15), phone2: text(20), fax: text(15), email: text(254) }),
  fiscal: z.strictObject({ taxId: uppercase(15), curp: uppercase(20), accountingAccount: uppercase(16) }),
  terms: z.strictObject({
    priceList: z.int().nonnegative().transform((list) => list < 1 || list > 5 ? 1 : list),
    discounts: z.tuple([discount, discount]), paymentTermDays: z.int().nonnegative(), creditLimit: z.int().nonnegative(),
    currencyId: z.int().min(0).max(2), type: z.int().min(0).max(2), applyToSupplierCode: uppercase(6),
  }),
});

const supplierParams = z.object({ supplierId: z.coerce.number().int().positive() });
const revision = z.string().regex(/^[0-9a-f]{64}$/);
const createBody = z.strictObject({ requestKey: z.uuid().transform((key) => key.toLowerCase()), fields });
const updateBody = z.strictObject({ revision, fields });
const deleteBody = z.strictObject({ revision, confirmed: z.literal(true) });
const classificationBody = z.strictObject({
  revision: z.int().nonnegative().max(2147483646), requestKey: z.uuid().transform((key) => key.toLowerCase()),
  current: z.array(z.string().max(5).refine((value) => !value.includes('\0'))).length(9),
});

export class SupplierCatalogController {
  constructor(private readonly catalog: WriteSupplierCatalog, private readonly suppliers: SuppliersDataSource) {}

  getCreate: RequestHandler = async (_request, response) => { response.json({ data: await this.catalog.getCreate() }); };

  getEdit: RequestHandler = async (request, response) => {
    const { supplierId } = supplierParams.parse(request.params);
    response.json({ data: await this.catalog.getEdit(supplierId) });
  };

  create: RequestHandler = async (request, response) => {
    const { requestKey, fields } = createBody.parse(request.body);
    const created = await this.catalog.create(requestKey, fields);
    const supplier = await this.suppliers.findById(created.id);
    response.status(201).json({ data: supplier?.toPrimitives() ?? created });
  };

  update: RequestHandler = async (request, response) => {
    const { supplierId } = supplierParams.parse(request.params);
    const { revision, fields } = updateBody.parse(request.body);
    const updated = await this.catalog.update(supplierId, revision, fields);
    const supplier = await this.suppliers.findById(supplierId);
    response.json({ data: supplier?.toPrimitives() ?? updated });
  };

  classify: RequestHandler = async (request, response) => {
    const { supplierId } = supplierParams.parse(request.params);
    response.json({ data: await this.catalog.classify(supplierId, classificationBody.parse(request.body)) });
  };

  remove: RequestHandler = async (request, response) => {
    const { supplierId } = supplierParams.parse(request.params);
    const { revision } = deleteBody.parse(request.body);
    await this.catalog.remove(supplierId, revision);
    response.status(204).send();
  };
}
