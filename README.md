# btc-race-24h-20261123-0511-entry

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Abkhas/btc-race-24h-20261123-0511-entry/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Abkhas/btc-race-24h-20261123-0511-entry/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A ladder dip-buyer BTC trading bot for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It buys small dips on a three-rung ladder against the trailing 60-bar high, guarantees participation with a bar-720 fallback buy, and splits exits between a fixed take-profit (half) and a trailing stop (half). Validated on 42 rolling 24h windows of public Coinbase BTC-USD candles: fired in 42/42, mean PnL -$0.92 over two net-down 10-day blocks (+$0.90 on the recent set), worst -$15.71. Dev-window grade-local: +$9.76 net PnL, 6 trades, 0.40% max drawdown.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 over stdin/stdout (Node 22, standard library only; the `vendor/` shim is the kit's own SDK file, copied byte-for-byte).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
