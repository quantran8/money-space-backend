import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should expose backend metadata', () => {
      expect(appController.getRoot()).toMatchObject({
        name: 'money-space-backend',
        status: 'ok',
      });
    });

    it('should expose health status', () => {
      expect(appController.getHealth()).toMatchObject({
        status: 'ok',
        service: 'money-space-backend',
      });
    });
  });
});
