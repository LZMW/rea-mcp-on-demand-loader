// End-to-end test for rea-mcp-proxy.mjs (on-demand loader).
// Run from the repo directory: `node test-proxy.mjs`
//   - default: launches the proxy, which spawns `rea --mcp` from PATH
//   - override: set REA_PROXY_NODE / REA_PROXY_SCRIPT to point at a specific
//     node binary / rea.mjs entry (the proxy passes them through).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const NODE = process.env.REA_PROXY_NODE ?? 'node';
const PROXY = fileURLToPath(new URL('./rea-mcp-proxy.mjs', import.meta.url));

const child = spawn(NODE, [PROXY], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
const notifications = [];
let nextId = 1;

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}
rl.on('line', (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  } else if (msg.method) {
    notifications.push(msg.method);
  }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
}

try {
  // 1. initialize
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'proxy-test', version: '1' } });
  check('initialize serverInfo', init?.serverInfo?.name === 'rea' && init?.serverInfo?.version === '6.4.0', JSON.stringify(init?.serverInfo));
  check('instructions has ON-DEMAND hint', typeof init?.instructions === 'string' && init.instructions.includes('ON-DEMAND'));
  notify('notifications/initialized');
  await new Promise((r) => setTimeout(r, 300));

  // 2. tools/list default -> core + control only
  const t1 = await request('tools/list', {});
  const names1 = (t1.tools ?? []).map((t) => t.name);
  check('default tools/list = core+control', names1.length === 10 + 4, `count=${names1.length}`);
  check('default has rea_tools_status', names1.includes('rea_tools_status'));
  check('default does NOT have native tool', !names1.includes('analyze_function'), `analyze_function present=${names1.includes('analyze_function')}`);
  check('default has core tool open_binary', names1.includes('open_binary'));

  // 3. rea_tools_status
  const st = await request('tools/call', { name: 'rea_tools_status', arguments: {} });
  const stText = st?.content?.[0]?.text ?? '';
  check('rea_tools_status returns text', stText.includes('REA on-demand loader status') && stText.includes('javascript'), stText.split('\n').slice(0, 4).join(' | '));

  // 4. enable javascript -> list_changed + new tools
  const en = await request('tools/call', { name: 'rea_tools_enable', arguments: { groups: ['javascript'] } });
  check('rea_tools_enable returns text', en?.content?.[0]?.text?.includes('enabled: javascript'));
  await new Promise((r) => setTimeout(r, 400));
  check('received tools/list_changed after enable', notifications.includes('notifications/tools/list_changed'), notifications.join(','));
  const t2 = await request('tools/list', {});
  const names2 = (t2.tools ?? []).map((t) => t.name);
  check('after enable javascript: count = 10+11+4', names2.length === 10 + 11 + 4, `count=${names2.length}`);
  check('after enable javascript: has analyze_javascript_application', names2.includes('analyze_javascript_application'));
  check('after enable javascript: still no native', !names2.includes('analyze_function'));

  // 5. real tool relay works (javascript tool actually forwarded to rea server)
  const call = await request('tools/call', { name: 'analyze_javascript_application', arguments: { input_path: 'Z:/definitely-not-a-real-app', format: 'auto', detail: 'summary' } });
  const callText = JSON.stringify(call);
  check('real tool relay: got a response (error or evidence)', callText.length > 0 && (call?.error || call?.content || call?.structuredContent), callText.slice(0, 200));

  // 6. disable + reset
  const dis = await request('tools/call', { name: 'rea_tools_disable', arguments: { groups: ['javascript'] } });
  await new Promise((r) => setTimeout(r, 300));
  const t3 = await request('tools/list', {});
  check('after disable: back to core+control', (t3.tools ?? []).length === 14, `count=${(t3.tools ?? []).length}`);
  await request('tools/call', { name: 'rea_tools_enable', arguments: { groups: ['native'] } });
  await new Promise((r) => setTimeout(r, 300));
  await request('tools/call', { name: 'rea_tools_reset', arguments: {} });
  await new Promise((r) => setTimeout(r, 300));
  const t4 = await request('tools/list', {});
  check('after reset: back to core+control', (t4.tools ?? []).length === 14, `count=${(t4.tools ?? []).length}`);

  // 7. enable "all"
  await request('tools/call', { name: 'rea_tools_enable', arguments: { groups: ['all'] } });
  await new Promise((r) => setTimeout(r, 400));
  const t5 = await request('tools/list', {});
  check('enable all: full 170+4', (t5.tools ?? []).length === 170 + 4, `count=${(t5.tools ?? []).length}`);

  child.kill();
  if (failures === 0) { console.log('PROXY TEST PASS'); process.exit(0); }
  console.log(`PROXY TEST FAILED (${failures})`); process.exit(1);
} catch (e) {
  console.error('PROXY TEST ERROR:', e.message);
  if (stderr) console.error('proxy stderr:', stderr.slice(0, 3000));
  child.kill();
  process.exit(2);
}
