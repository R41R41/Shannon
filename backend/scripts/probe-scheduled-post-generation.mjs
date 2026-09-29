// Explicitly gated, billable generation probe. Never sends to Discord or X.
if (!process.argv.includes('--live')) {
  console.error('Use --live from a backend directory with deliberately supplied credentials.');
  process.exit(2);
}
const report = console.log.bind(console);
const counters = { attempts: 0, budgetFailures: 0, approved: 0 };
console.log = console.info = console.warn = console.error = (...args) => {
  const line = args.filter(arg => typeof arg === 'string').join(' ');
  if (line.includes('探索+生成')) counters.attempts++;
  if (line.includes('SCHEDULED_POST_TOOL_BUDGET')) counters.budgetFailures++;
  if (line.includes('レビュー合格')) counters.approved++;
};
let failed = false;
for (const [kind, file, name] of [
  ['news', 'postNewsAgent', 'PostNewsAgent'],
  ['about_today', 'postAboutTodayAgent', 'PostAboutTodayAgent'],
]) {
  counters.attempts = 0; counters.budgetFailures = 0; counters.approved = 0;
  const start = Date.now();
  try {
    const module = await import(`../dist/services/llm/agents/${file}.js`);
    const agent = await module[name].create();
    const result = await agent.createPost(AbortSignal.timeout(180000));
    const fallback = /うまく見つけられなかった/.test(result.text);
    const success = !fallback && !!result.imagePrompt && counters.budgetFailures === 0;
    failed ||= !success;
    report(JSON.stringify({ kind, success, elapsedMs: Date.now() - start,
      textLength: result.text.length, imagePrompt: !!result.imagePrompt, fallback, ...counters }));
  } catch (error) {
    failed = true;
    report(JSON.stringify({ kind, success: false, error: error.name, elapsedMs: Date.now() - start, ...counters }));
  }
}
process.exit(failed ? 1 : 0);
