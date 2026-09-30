// The legacy order header can store Mexico as 1; its catalog and stock keys use 01.
export const normalizeOrderWarehouse = (warehouse: string): string => {
  const code = warehouse.trim();
  return code === '1' ? '01' : code;
};
