import { expect, it } from 'vitest';
import { bankCatalogDefaults, projectBankCatalog } from '../src/modules/treasury/banking/domain/entities/bank-catalog.js';

it('preserves native fiscal values and counters for catalog snapshots written before those fields were editable', () => {
  const defaults = bankCatalogDefaults();
  const catalog = { id: 6610, revision: 1, createdOn: '2026-01-01' };
  const fiscalReports = { annualInflationAdjustment: 2, deductibleIetu: true, nonDeductibleVat: false };
  const legacy = projectBankCatalog(null, {
    ...catalog, legacy: false,
    fields: { ...defaults, fiscalReports, control: { ...defaults.control, nextCheckNumber: 41, movements: true } },
  }, false);

  const previous = projectBankCatalog(legacy, {
    ...catalog, legacy: true, fields: { ...defaults, name: 'Nombre guardado', fiscalReports: undefined },
  }, false)?.toPrimitives();

  expect(previous).toMatchObject({
    name: 'Nombre guardado', fiscalReports,
    control: { nextCheckNumber: 41, movements: true },
  });

  const current = projectBankCatalog(legacy, {
    ...catalog, legacy: true,
    fields: {
      ...defaults,
      fiscalReports: { annualInflationAdjustment: 1, deductibleIetu: false, nonDeductibleVat: true },
      control: { ...defaults.control, nextCheckNumber: 52 },
    },
  }, false)?.toPrimitives();

  expect(current).toMatchObject({
    fiscalReports: { annualInflationAdjustment: 1, deductibleIetu: false, nonDeductibleVat: true },
    control: { nextCheckNumber: 52, movements: true },
  });
});
