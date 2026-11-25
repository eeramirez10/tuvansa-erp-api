import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { WriteSupplierCatalog } from '../../application/use-cases/write-supplier-catalog.js';
import type { SuppliersDataSource } from '../../domain/datasources/suppliers-data-source.js';
import type { SupplierActivityKind } from '../../domain/entities/supplier-activity.js';

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
const key = z.uuid().transform((value) => value.toLowerCase());
const activityParams = supplierParams.extend({
  activityId: z.union([key, z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.int().positive())]),
});
const localText = (limit: number) => z.string().max(limit).refine((value) => !value.includes('\0'));
const unsignedByte = z.int().min(0).max(255);
const dayCount = z.int().min(0).max(2147483647);
const percentage = z.number().min(0).max(100).multipleOf(0.0001);
const decimal = z.number().min(-90071992547409).max(90071992547409).multipleOf(0.01);
const workInteger = z.int().min(-2147483648).max(2147483647);
const variousBody = z.strictObject({
  requestKey: key, revision: z.int().nonnegative().max(2147483646),
  fields: z.strictObject({
    branch: localText(4), bankAccount: localText(20), bankCode: localText(5), city: localText(4), state: localText(2),
    cieReference: localText(20), internetPassword: localText(8), multiCompany: unsignedByte, interCompany: z.int().min(0).max(1),
    deliveryDays: dayCount, purchaseFrequencyDays: dayCount, tolerancePercent: z.int().nonnegative(), vatType: z.int().min(0).max(2),
    vatWithholdingPercent: percentage, incomeTaxWithholdingPercent: percentage,
    thirdPartyType: localText(2), operationType: localText(2), countryCode: localText(2),
    minimums: z.tuple([workInteger, decimal, decimal, workInteger, workInteger, workInteger, workInteger, workInteger]),
    values: z.array(decimal).length(12),
  }),
});
const eventFields = z.strictObject({
  date: z.iso.date(), title: localText(70), description: localText(19200),
  followUpAt: z.iso.date().nullable(), dueAt: z.iso.date().nullable(), project: localText(12),
});
const contactFields = z.strictObject({
  name: localText(50), position: localText(50), phone1: localText(15), phone2: localText(15), fax: localText(15),
  email: localText(50), notes: localText(400), interests: localText(50), birthday: z.iso.date().nullable(),
});
const createEvent = z.strictObject({ requestKey: key, fields: eventFields });
const createContact = z.strictObject({ requestKey: key, fields: contactFields });
const changeEvent = createEvent.extend({ revision: z.int().nonnegative().max(2147483646) });
const deleteActivity = z.strictObject({
  requestKey: key, revision: z.int().nonnegative().max(2147483646), confirmed: z.literal(true),
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

  saveVarious: RequestHandler = async (request, response) => {
    const { supplierId } = supplierParams.parse(request.params);
    const { revision, requestKey, fields } = variousBody.parse(request.body);
    response.json({ data: await this.catalog.saveVarious(supplierId, revision, requestKey, fields) });
  };

  addActivity = (kind: SupplierActivityKind): RequestHandler => async (request, response) => {
    const { supplierId } = supplierParams.parse(request.params);
    const { requestKey, fields } = (kind === 'events' ? createEvent : createContact).parse(request.body);
    const data = await this.catalog.writeActivity(supplierId, kind, 'create', requestKey, { requestKey, fields, revision: 0 });
    response.status(201).json({ data });
  };

  changeEvent: RequestHandler = async (request, response) => {
    const { supplierId, activityId } = activityParams.parse(request.params);
    const data = await this.catalog.writeActivity(supplierId, 'events', 'change', activityId, changeEvent.parse(request.body));
    response.json({ data });
  };

  removeActivity = (kind: SupplierActivityKind): RequestHandler => async (request, response) => {
    const { supplierId, activityId } = activityParams.parse(request.params);
    const { requestKey, revision } = deleteActivity.parse(request.body);
    await this.catalog.writeActivity(supplierId, kind, 'remove', activityId, { requestKey, revision, fields: {} });
    response.status(204).send();
  };

  remove: RequestHandler = async (request, response) => {
    const { supplierId } = supplierParams.parse(request.params);
    const { revision } = deleteBody.parse(request.body);
    await this.catalog.remove(supplierId, revision);
    response.status(204).send();
  };
}
