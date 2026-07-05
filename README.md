# Entry ML Candle Tier Live Dashboard

기존 Entry ML v2.2 대시보드 사본 위에 Candle Frequency `Tier0`, `Tier1`, `Tier2` 실시간 알람 마커를 얹는 독립 대시보드다.

## Data Routing

- Supabase: `alert_markers` public read
- Chart API: `/api/live-klines`
- Static replay data: 기존 배포본 `https://tv-local-macro-onchain-vercel.vercel.app/data/entry_ml_v2_2`
- Tier routing:
  - `candle_frequency_tier0`
  - `candle_frequency_tier1`
  - `candle_frequency_tier2`

## Safety

프런트에는 Supabase publishable key만 포함한다. 서비스롤 키와 거래소 키는 포함하지 않는다.

## Local

```bash
npm run build
npx vercel dev --listen 127.0.0.1:8795
```
