import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma/prisma.module';
import { AuditService } from './audit/audit.service';

@Module({
  imports: [PrismaModule],
  providers: [AuditService],
  exports: [PrismaModule, AuditService],
})
export class CommonModule {}
