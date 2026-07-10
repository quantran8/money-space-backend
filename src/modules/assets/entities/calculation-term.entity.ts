export interface CalculationTerm {
  calculationType:
    'saving_deposit' | 'bond' | 'loan_receivable' | 'certificate_of_deposit';
  principalAmount: number;
  interestRate: number;
  startDate: string;
  maturityDate: string | null;
}
