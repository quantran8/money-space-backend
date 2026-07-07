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
        '/api/households',
        '/api/households/:householdId/dashboard',
        '/api/households/:householdId/assets',
        '/api/households/:householdId/members',
        '/api/households/:householdId/money-events',
        '/api/households/:householdId/upcoming-payments',
        '/api/households/:householdId/financial-goals',
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
