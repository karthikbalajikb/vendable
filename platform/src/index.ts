import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { onboardStore } from './onboard/onboard.js';
import { buy } from './agent/buyerAgent.js';
import { costCurve } from './bench/costCurve.js';
import { WebcmdClient } from './webcmd/webcmdClient.js';
import { startServer } from './server/server.js';
import { startMcpServer } from './mcp/mcpServer.js';

// Load .env from the repo root first (works regardless of the cwd `npm run` uses), then cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../../.env') });
loadEnv();

const program = new Command();
program.name('vendable').description('URL -> vendable store (webcmd + Prava)');

program
  .command('onboard')
  .argument('<url>', 'store URL')
  .description('crawl a store and produce an Agent Commerce Manifest')
  .action(async (url: string) => {
    const manifest = await onboardStore(url);
    console.log(JSON.stringify(manifest, null, 2));
  });

program
  .command('buy')
  .argument('<goal>', 'what to buy, e.g. "buy the Dark Knight poster under 500"')
  .option('-u, --url <url>', 'store URL', process.env.DEMO_STORE_URL ?? 'https://theprintsmithstore.com/')
  .description('act as a buyer agent against an onboarded store')
  .action(async (goal: string, opts: { url: string }) => {
    const manifest = await onboardStore(opts.url);
    const { pick, receipt } = await buy(manifest, goal);
    console.log(`\nBought: ${pick.title}  (${pick.currency} ${pick.price})`);
    console.log('Receipt:', receipt);
  });

program
  .command('commands')
  .description('list the compiled webcmd adapter commands (webcmd list)')
  .action(async () => {
    const cmds = await new WebcmdClient().list();
    for (const c of cmds) console.log(`  ${c.site} ${c.command}  [${c.strategy}${c.browser ? ', browser' : ''}]`);
  });

program
  .command('bench')
  .option('-a, --adapter <name>', 'webcmd adapter', 'printsmith')
  .option('-n, --runs <n>', 'repeat runs', '5')
  .description('show the webcmd cost curve (repeat-run latency + token-index model)')
  .action(async (opts: { adapter: string; runs: string }) => {
    await costCurve(opts.adapter, Number(opts.runs));
  });

program
  .command('serve')
  .option('-p, --port <port>', 'port', process.env.PORT ?? '4000')
  .description('run the onboarding dashboard (web UI + API)')
  .action((opts: { port: string }) => {
    startServer(Number(opts.port));
  });

program
  .command('mcp')
  .option('-p, --port <port>', 'port', process.env.MCP_PORT ?? '4001')
  .description('run the ChatGPT MCP connector (Streamable HTTP at /mcp)')
  .action((opts: { port: string }) => {
    startMcpServer(Number(opts.port));
  });

program.parseAsync();
