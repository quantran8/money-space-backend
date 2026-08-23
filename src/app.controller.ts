import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './modules/auth/decorators/public.decorator';

// Version-neutral: `/` and `/health` stay off the versioned surface. The
// container healthcheck in deploy/docker-compose.prod.yml hits /health
// directly, so it must not move when the API version changes.
@Controller({ version: VERSION_NEUTRAL })
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getRoot() {
    return this.appService.getRoot();
  }

  @Public()
  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }
}
