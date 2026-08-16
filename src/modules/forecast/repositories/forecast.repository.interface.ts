import type { Household } from '../../households/entities/household.entity';
import type {
  ForecastCashflowEvent,
  ForecastLiquidSource,
} from '../domain/forecast.types';

export const FORECAST_REPOSITORY = Symbol('FORECAST_REPOSITORY');

export interface ForecastBundle {
  assets: ForecastLiquidSource[];
  cashflowEvents: ForecastCashflowEvent[];
}

export interface ForecastRepository {
  assertHousehold(householdId: string): Promise<Household>;
  /**
   * Everything a forecast run needs, in one parallel fan-out.
   *
   * Loaded ONCE per request: what-if runs the engine twice (before/after) over
   * the same bundle rather than hitting the database twice.
   */
  loadForecastBundle(householdId: string): Promise<ForecastBundle>;
}
