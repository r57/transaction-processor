import { Readable } from "stream";
import { S3 } from 'aws-sdk';
import csv = require('csv-parser');

const s3 = new S3();

interface S3Event {
  s3Bucket: string;
  s3Key: string;
}

export interface CsvRecord {
  ID: string;
  Date: string;
  AccountID: string;
  Amount: string;
}

export interface TransactionRecord {
  id: string;
  date: string;
  accountId: string;
  amount: string;
}

export const handler = async (event: S3Event): Promise<TransactionRecord[]> => {
  const s3Bucket = event.s3Bucket;
  const s3Key = event.s3Key;

  const csvFile = await s3.getObject({
    Bucket: s3Bucket,
    Key: s3Key,
  }).promise();

  const csvData = csvFile.Body!.toString('utf-8');
  const records = await parseCSV(csvData);

  console.log(`Processed ${records.length} records from ${s3Bucket}/${s3Key}`);

  return records;
};

const parseCSV = (data: string): Promise<TransactionRecord[]> => {
  const readable = Readable.from([data])
  return new Promise((resolve, reject) => {
    const records: TransactionRecord[] = [];

    readable
      .pipe(csv())
      .on('data', (record: CsvRecord) => {
        records.push({
          id: record.ID,
          date: record.Date,
          accountId: record.AccountID,
          amount: record.Amount,
        });
      })
      .on('end', () => {
        resolve(records);
      })
      .on('error', (error: Error) => {
        reject(error);
      });
  });
};
