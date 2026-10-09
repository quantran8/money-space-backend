-- A borrower repaid a loan_receivable in full. See memory/loan-receivable.md.
ALTER TYPE "MoneyEventType" ADD VALUE IF NOT EXISTS 'loan_collection';
