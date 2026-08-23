import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getRoot() {
    return {
      name: 'money-space-backend',
      status: 'ok',
      version: '0.0.1',
      endpoints: [
        '/health',
        '/api/v1/households',
        '/api/v1/households/:householdId/dashboard',
        '/api/v1/households/:householdId/assets',
        '/api/v1/households/:householdId/debts',
        '/api/v1/households/:householdId/members',
        '/api/v1/households/:householdId/money-events',
        '/api/v1/households/:householdId/upcoming-payments',
        '/api/v1/households/:householdId/financial-goals',
      ],
    };
  }

  getHealth() {
    return {
      status: 'ok',
      service: 'money-space-backend',
      timestamp: new Date().toISOString(),
    };
  }
}
