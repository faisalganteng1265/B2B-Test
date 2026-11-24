/**
 * Mock bank directory used by bifast-mock (account inquiry) and the DB seed.
 * Account 9990000001 is closed: transfers to it fail with ACCOUNT_CLOSED (for the demo).
 */
export interface BankDirectoryEntry {
  bankCode: string;
  accountNumber: string;
  accountName: string;
  status: 'active' | 'closed';
}

export const BANK_DIRECTORY: BankDirectoryEntry[] = [
  {
    bankCode: '014',
    accountNumber: '8830112233',
    accountName: 'PT NUSANTARA DIGITAL NIAGA',
    status: 'active',
  },
  {
    bankCode: '008',
    accountNumber: '1230009988',
    accountName: 'PT GARUDA LOGISTIK EKSPRES',
    status: 'active',
  },
  { bankCode: '009', accountNumber: '0451239876', accountName: 'PT SINAR KOPI NUSANTARA', status: 'active' },
  { bankCode: '002', accountNumber: '9990000001', accountName: 'PT TUTUP BUKU SELAMANYA', status: 'closed' },
];

export const BANK_NAMES: Record<string, string> = {
  '002': 'BRI',
  '008': 'Mandiri',
  '009': 'BNI',
  '014': 'BCA',
};
