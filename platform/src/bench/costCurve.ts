import { performance } from 'node:perf_hooks';
import { WebcmdClient } from '../webcmd/webcmdClient.js';

/** Illustrative repeat-run token index published by webcmd (lower is better). */
const TOKEN_INDEX = [
  { layer: 'Fresh browser replay', index: 100, turns: 9.0 },
  { layer: 'Sitemap-guided', index: 58, turns: 6.0 },
  { layer: 'Reusable adapter', index: 24, turns: 2.0 },
  { layer: 'Tailored command', index: 10, turns: 1.0 },
];

/**
 * The webcmd cost story: authoring a command is a one-time browse; every repeat run
 * executes the compiled command with no LLM navigation. We time N repeat runs of the
 * compiled `<adapter> catalog` command and print webcmd's published token-index model.
 */
export async function costCurve(adapter: string, runs = 5): Promise<void> {
  const webcmd = new WebcmdClient();
  const mock = await webcmd.isMock();
  console.log(`\nwebcmd cost curve — adapter="${adapter}"  runs=${runs}  mode=${mock ? 'MOCK' : 'LIVE'}\n`);

  const timings: number[] = [];
  for (let i = 1; i <= runs; i++) {
    const t0 = performance.now();
    const catalog = await webcmd.crawlCatalog(adapter);
    const ms = performance.now() - t0;
    timings.push(ms);
    console.log(`  run ${i}: ${ms.toFixed(1)} ms  (${catalog.length} items)`);
  }
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  console.log(`  avg repeat-run latency: ${avg.toFixed(1)} ms\n`);

  console.log('  Model (webcmd published index, illustrative — replace with observed token counts):');
  for (const r of TOKEN_INDEX) {
    console.log(`    ${r.layer.padEnd(22)} token-index ${String(r.index).padStart(3)}  · ${r.turns} agent turns/run`);
  }
  console.log('\n  First run authors the command once (browse + INTERCEPT); every repeat run executes');
  console.log('  the compiled command with no LLM navigation — ~90% fewer input tokens, 1 turn.\n');
}
