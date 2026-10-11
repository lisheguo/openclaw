// Offline synthetic benchmark; never changes runtime capacity or retention.
// Run: node test/bench/replay-memory.mjs > /tmp/replay-memory.json
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const baseline = 'a5ced4800591f96563b891dceae205954dae1221';
const script = fileURLToPath(import.meta.url);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const collect = () => { for (let i = 0; i < 3; i++) global.gc(); };

if (process.argv[2] === '--sample') {
  if (!global.gc) throw new Error('Sample requires --expose-gc');
  const [, , , moduleUrl, countArg, scopesArg, bytesArg] = process.argv;
  const count = Number(countArg), scopes = Number(scopesArg), bodyBytes = Number(bytesArg);
  const { createInboundReplayGuard } = await import(moduleUrl);
  const text = 'x'.repeat(bodyBytes);
  const input = i => ({ channelId: 'feishu', accountId: 'fixture-account', conversationId: 'fixture-chat',
    sessionKey: 'fixture-session', senderId: `fixture-user-${i % scopes}`, messageId: `fixture-message-${i}`, text });
  const mutate = () => 1;
  (() => { const warm = createInboundReplayGuard(); for (let i = 0; i < 512; i++) warm.run(input(i), mutate); })();
  collect(); const emptyBefore = process.memoryUsage().heapUsed;
  const guard = createInboundReplayGuard(); collect(); const before = process.memoryUsage().heapUsed;
  const start = performance.now(); for (let i = 0; i < count; i++) guard.run(input(i), mutate);
  const fillMs = performance.now() - start; collect(); const after = process.memoryUsage().heapUsed;
  const duplicateStart = performance.now(); for (let i = 0; i < 2000; i++) guard.run(input(i % count), mutate);
  const duplicateMs = performance.now() - duplicateStart;
  let metricsReadMs = null;
  if (guard.metrics) { const t = performance.now(); for (let i = 0; i < 10000; i++) guard.metrics(); metricsReadMs = performance.now() - t; }
  process.stdout.write(JSON.stringify({ empty_guard_heap_bytes: before - emptyBefore, retained_delta_bytes: after - before,
    retained_bytes_per_receipt: (after - before) / count, fill_ms: fillMs, duplicate_2000_ms: duplicateMs,
    metrics_10000_reads_ms: metricsReadMs, used: guard.size() }));
} else {
  const temp = mkdtempSync(path.join(tmpdir(), 'glpi-replay-bench-'));
  try {
    const original = execFileSync('git', ['show', `${baseline}:lib/inbound-replay.js`], { cwd: repository, encoding: 'utf8' });
    const baseFile = path.join(temp, 'baseline.mjs'); writeFileSync(baseFile, original);
    const modules = { baseline: pathToFileURL(baseFile).href, metrics: new URL('../../lib/inbound-replay.js', import.meta.url).href };
    const conditions = [ [1024,1,128], [1024,1024,128], [4096,1,128], [4096,4096,128], [4096,1,16384] ];
    const results = [];
    for (const [count, scopes, bodyBytes] of conditions) for (const [variant, moduleUrl] of Object.entries(modules)) {
      const samples = [];
      for (let trial = 0; trial < 3; trial++) samples.push(JSON.parse(execFileSync(process.execPath,
        ['--expose-gc', script, '--sample', moduleUrl, String(count), String(scopes), String(bodyBytes)], { encoding: 'utf8' })));
      const median = field => [...samples.map(x => x[field])].sort((a,b) => a-b)[1];
      results.push({ variant, count, scopes, body_bytes: bodyBytes, samples,
        median_bytes_per_receipt: median('retained_bytes_per_receipt'), median_fill_ms: median('fill_ms'),
        median_duplicate_2000_ms: median('duplicate_2000_ms'), median_metrics_10000_reads_ms: variant === 'metrics' ? median('metrics_10000_reads_ms') : null });
    }
    process.stdout.write(JSON.stringify({ baseline_commit: baseline, node: process.version, platform: process.platform, arch: process.arch,
      default_capacity: 4096, trials_per_condition: 3, full_runner_executed: false,
      methodology: 'Fresh child per sample; 512 warmup reservations; triple forced GC; retained heap delta after filling minus empty guard; sequential trials. Synthetic in-process measurements, not production sizing or a strict memory bound.', results }, null, 2) + '\n');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
