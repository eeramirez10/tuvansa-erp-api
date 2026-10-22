import type { IncomeStatement, IncomeStatementAccount, IncomeStatementCriteria, IncomeStatementRow, IncomeStatementSettings } from './income-statement.js';

const cents = (value: number) => Math.round(value * 100);
const money = (value: number) => value === 0 ? 0 : value / 100;
type Node = { account: IncomeStatementAccount; depth: number; children: Node[]; month: number; accumulated: number };

// DERIVADA: presentation/sign rules checked against the supplied OMNIS PDF and local balances.
// Parent balances already include descendants. Never add parents to children.
export const buildIncomeStatement = (
  settings: IncomeStatementSettings, criteria: IncomeStatementCriteria, accounts: IncomeStatementAccount[],
  asOf: string, generatedAt: string,
): IncomeStatement => {
  const roots: Node[] = [];
  const stack: Node[] = [];
  const seen = new Set<string>();
  for (const account of [...accounts].sort((a,b)=>a.code.localeCompare(b.code,'en'))) {
    if (seen.has(account.code)) throw new Error('Duplicate accounting code in income statement');
    seen.add(account.code);
    while (stack.length && !account.code.startsWith(stack.at(-1)!.account.code)) stack.pop();
    const node: Node = {account,depth:stack.length,children:[],
      month:cents(account.debit)-cents(account.credit),accumulated:cents(account.balance)};
    if (stack.length) stack.at(-1)!.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  const visible = (node: Node): boolean => node.month !== 0 || node.accumulated !== 0 || node.children.some(visible);
  const rows: IncomeStatementRow[] = [];
  const heading = (node: Node, kind: 'section'|'group') => rows.push({
    key:kind+':'+node.account.code,code:node.account.code,label:node.account.name,depth:node.depth,kind,month:null,accumulated:null,
  });
  const amounts = (node: Node, kind: 'account'|'subtotal'|'section-total', label = node.account.name) => {
    const sign = node.account.nature === 1 ? -1 : 1;
    rows.push({key:kind+':'+node.account.code,code:node.account.code,label,depth:node.depth,kind,
      month:money(node.month*sign),accumulated:money(node.accumulated*sign)});
  };
  const children = (node: Node) => {
    if (!visible(node)) return;
    const descendants = node.children.filter(visible);
    if (!descendants.length) amounts(node,'account');
    else {
      heading(node,'group');
      descendants.forEach(children);
      amounts(node,'subtotal','');
    }
  };
  let month = 0, accumulated = 0;
  for (const root of roots.filter(visible)) {
    heading(root,'section');
    root.children.forEach(children);
    amounts(root,'section-total','TOTAL DE  '+root.account.name);
    month -= root.month; accumulated -= root.accumulated;
  }
  if (rows.length) rows.push({key:'result',code:'',label:'RESULTADO DEL EJERCICIO',depth:0,kind:'result',month:money(month),accumulated:money(accumulated)});
  return {title:'ESTADO DE RESULTADOS',companyName:settings.companyName,companyLegalName:settings.companyLegalName,
    generatedAt,asOf,criteria,rows,totals:{month:money(month),accumulated:money(accumulated)},empty:rows.length===0};
};
