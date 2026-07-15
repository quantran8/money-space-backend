import type { SymbolReference } from '../entities/symbol-reference.entity';
import type { SymbolAssetClass } from './symbol-reference-provider.interface';

/**
 * Curated popular tickers shown before the user types. Resolved against the
 * live reference list so names/exchanges stay accurate; the fallback entry here
 * is used when reference data is unavailable (no API key / upstream down).
 */
export const DEFAULT_SYMBOLS: Record<SymbolAssetClass, SymbolReference[]> = {
  stock: [
    {
      assetClass: 'stock',
      symbol: 'AAPL',
      name: 'Apple Inc',
      exchange: 'NASDAQ',
      currency: 'USD',
      unit: 'cp',
    },
    {
      assetClass: 'stock',
      symbol: 'MSFT',
      name: 'Microsoft Corp',
      exchange: 'NASDAQ',
      currency: 'USD',
      unit: 'cp',
    },
    {
      assetClass: 'stock',
      symbol: 'NVDA',
      name: 'NVIDIA Corp',
      exchange: 'NASDAQ',
      currency: 'USD',
      unit: 'cp',
    },
    {
      assetClass: 'stock',
      symbol: 'GOOGL',
      name: 'Alphabet Inc',
      exchange: 'NASDAQ',
      currency: 'USD',
      unit: 'cp',
    },
    {
      assetClass: 'stock',
      symbol: 'AMZN',
      name: 'Amazon.com Inc',
      exchange: 'NASDAQ',
      currency: 'USD',
      unit: 'cp',
    },
    {
      assetClass: 'stock',
      symbol: 'META',
      name: 'Meta Platforms Inc',
      exchange: 'NASDAQ',
      currency: 'USD',
      unit: 'cp',
    },
    {
      assetClass: 'stock',
      symbol: 'TSLA',
      name: 'Tesla Inc',
      exchange: 'NASDAQ',
      currency: 'USD',
      unit: 'cp',
    },
    {
      assetClass: 'stock',
      symbol: 'SPY',
      name: 'SPDR S&P 500 ETF Trust',
      exchange: 'NYSE',
      currency: 'USD',
      unit: 'cp',
    },
  ],
  crypto: [
    {
      assetClass: 'crypto',
      symbol: 'BTC',
      name: 'Bitcoin',
      exchange: '',
      currency: 'USD',
      unit: 'coin',
    },
    {
      assetClass: 'crypto',
      symbol: 'ETH',
      name: 'Ethereum',
      exchange: '',
      currency: 'USD',
      unit: 'coin',
    },
    {
      assetClass: 'crypto',
      symbol: 'BNB',
      name: 'Binance Coin',
      exchange: '',
      currency: 'USD',
      unit: 'coin',
    },
    {
      assetClass: 'crypto',
      symbol: 'SOL',
      name: 'Solana',
      exchange: '',
      currency: 'USD',
      unit: 'coin',
    },
    {
      assetClass: 'crypto',
      symbol: 'XRP',
      name: 'XRP',
      exchange: '',
      currency: 'USD',
      unit: 'coin',
    },
    {
      assetClass: 'crypto',
      symbol: 'ADA',
      name: 'Cardano',
      exchange: '',
      currency: 'USD',
      unit: 'coin',
    },
    {
      assetClass: 'crypto',
      symbol: 'DOGE',
      name: 'Dogecoin',
      exchange: '',
      currency: 'USD',
      unit: 'coin',
    },
    {
      assetClass: 'crypto',
      symbol: 'USDT',
      name: 'Tether',
      exchange: '',
      currency: 'USD',
      unit: 'coin',
    },
  ],
};
