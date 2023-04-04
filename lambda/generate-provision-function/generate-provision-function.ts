import { randomUUID } from "crypto";
import { Big } from 'big.js';

export interface TransactionRecord {
  id: string;
  date: string;
  accountId: string;
  amount: string;
}

export const handler = async (
  record: TransactionRecord
): Promise<TransactionRecord> => {
  const provisionRatio = process.env.PROVISION_RATIO;
  if (provisionRatio) {
    return Promise.resolve({
      id: randomUUID(),
      date: record.date,
      accountId: record.accountId,
      amount: Big(record.amount).times(provisionRatio).toString(),
    });
  } else {
    throw new Error("PROVISION_RATIO env var not defined")
  }

};
