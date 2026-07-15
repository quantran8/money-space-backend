import { Injectable } from '@nestjs/common';
import type { SymbolReference } from '../entities/symbol-reference.entity';
import type { SymbolReferenceProvider } from './symbol-reference-provider.interface';

/** Default until a real reference provider (Twelve Data) is configured. */
@Injectable()
export class NoopSymbolReferenceProvider implements SymbolReferenceProvider {
  listSymbols(): Promise<SymbolReference[]> {
    return Promise.resolve([]);
  }
}
