# Entry ML Candle Tier Live Dashboard

Entry ML v2.2 Candle Frequency `Tier0`, `Tier1`, `Tier2` 실시간 알람을 Supabase `alert_markers`에서 읽어 live 5m/15m/1h 차트 위에 표시하는 독립 대시보드다.

## Data Routing

- Supabase: `alert_markers` public read
- Chart API: `/api/live-klines`
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

