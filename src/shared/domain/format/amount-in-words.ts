const small = ['CERO','UNO','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE','DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE','DIECISÉIS','DIECISIETE','DIECIOCHO','DIECINUEVE','VEINTE','VEINTIUNO','VEINTIDÓS','VEINTITRÉS','VEINTICUATRO','VEINTICINCO','VEINTISÉIS','VEINTISIETE','VEINTIOCHO','VEINTINUEVE'];
function integerWords(n: number): string {
  if (n < 30) return small[n]!;
  if (n < 100) return ['', '', '', 'TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA'][Math.floor(n / 10)]! + (n % 10 ? ` Y ${integerWords(n % 10)}` : '');
  if (n === 100) return 'CIEN';
  if (n < 1000) return ['', 'CIENTO','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS','SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS'][Math.floor(n / 100)]! + (n % 100 ? ` ${integerWords(n % 100)}` : '');
  const scale = n < 1_000_000 ? 1000 : 1_000_000;
  const group = Math.floor(n / scale);
  const prefix = group === 1 ? (scale === 1000 ? 'MIL' : 'UN MILLÓN') : `${integerWords(group).replace(/UNO$/, 'UN')} ${scale === 1000 ? 'MIL' : 'MILLONES'}`;
  return prefix + (n % scale ? ` ${integerWords(n % scale)}` : '');
}
export function amountInWords(total: number): string {
  const cents = Math.round(total * 100);
  return `${integerWords(Math.floor(cents / 100))} ${String(cents % 100).padStart(2, '0')}/100`;
}
