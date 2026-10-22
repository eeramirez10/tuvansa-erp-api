import type { IncomeStatementAccount } from './income-statement.js';

// DERIVADA: sum the same accounting codes across companies in cents, not parents plus children.
export function consolidateIncomeStatementAccounts(groups: IncomeStatementAccount[][]): IncomeStatementAccount[] {
  const totals=new Map<string,IncomeStatementAccount>();
  for(const accounts of groups) {
    const seen=new Set<string>();
    for(const account of accounts) {
      if(seen.has(account.code))throw new Error('Duplicate accounting code in branch');
      seen.add(account.code);
      const previous=totals.get(account.code);
      if(previous && previous.nature!==account.nature)throw new Error('Inconsistent account nature across branches');
      if(!previous)totals.set(account.code,{...account,balance:Math.round(account.balance*100),debit:Math.round(account.debit*100),credit:Math.round(account.credit*100)});
      else { previous.balance+=Math.round(account.balance*100);previous.debit+=Math.round(account.debit*100);previous.credit+=Math.round(account.credit*100); }
    }
  }
  return [...totals.values()].map((account,index)=>({...account,id:index+1,balance:account.balance/100,debit:account.debit/100,credit:account.credit/100}));
}
