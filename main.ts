// Flowjack94 pump.fun paper sprint bot — a momentum rider for agent-fun/replay/v2.
// The grader runs `node /bot/main.ts`. The strategy lives in strategy.ts; the
// harness shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
