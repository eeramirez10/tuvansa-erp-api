import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ManagePurchaseReceptionPieces } from '../../application/use-cases/manage-purchase-reception-pieces.js';

const companyId = 1;
const id = z.coerce.number().int().positive();
const lineParams = z.object({ purchaseReceptionId: id, lineId: id });
const pieceParams = z.object({ purchaseReceptionId: id, pieceId: id });
const revision = z.string().regex(/^[0-9a-f]{64}$/);
const serial = z.string().trim().min(1).max(30);
const addSchema = z.strictObject({
  serial,
  quantity: z.number().positive().refine((value) =>
    Number.isSafeInteger(Math.round(value * 1000)) && Number(value.toFixed(3)) === value,
  'Captura una cantidad de hasta tres decimales dentro del rango permitido.'),
  reference: z.string().trim().max(15),
  requestKey: z.uuid(),
  revision,
});
const editSchema = z.strictObject({ pieces: z.string().max(24000), revision });
const updateSerialSchema = z.strictObject({ serial, previousSerial: z.string().max(30) });

export class PurchaseReceptionPiecesController {
  constructor(private readonly pieces: ManagePurchaseReceptionPieces) {}

  prepare: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId, lineId } = lineParams.parse(request.params);
      const data = await this.pieces.prepare(companyId, purchaseReceptionId, lineId);
      response.set('Cache-Control', 'no-store').json({ data });
    } catch (error) { next(error); }
  };

  add: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId, lineId } = lineParams.parse(request.params);
      const data = await this.pieces.add(companyId, purchaseReceptionId, lineId, addSchema.parse(request.body));
      response.status(201).json({ data });
    } catch (error) { next(error); }
  };

  edit: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId, lineId } = lineParams.parse(request.params);
      const data = await this.pieces.edit(companyId, purchaseReceptionId, lineId, editSchema.parse(request.body));
      response.json({ data });
    } catch (error) { next(error); }
  };

  updateSerial: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId, pieceId } = pieceParams.parse(request.params);
      const data = await this.pieces.updateSerial(companyId, purchaseReceptionId, pieceId, updateSerialSchema.parse(request.body));
      response.json({ data });
    } catch (error) { next(error); }
  };
}
