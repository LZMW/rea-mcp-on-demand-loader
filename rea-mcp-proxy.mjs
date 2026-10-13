#!/usr/bin/env node
// REA MCP on-demand loader proxy.
//
// Bridges the real `rea --mcp` stdio server to DSH's dsh-mcp-client, but only
// exposes a small curated set of tools by default. When the agent calls one of
// the proxy's control tools (rea_tools_status / rea_tools_enable /
// rea_tools_disable / rea_tools_reset) the enabled groups change and the proxy
// emits `notifications/tools/list_changed`; DSH's mcp-client re-fetches
// tools/list and the newly enabled tools appear live (same mechanism the
// godot-mcp toolset uses).
//
// Group assignment is explicit and exhaustive: every tool the real server
// advertises must belong to exactly one group (or core). Startup verifies
// coverage and warns about any drift after a rea-agents upgrade.

import { spawn } from 'node:child_process';
import readline from 'node:readline';

// ── Real server launch ─────────────────────────────────────────────────────
// Two modes:
//   1) explicit: set REA_PROXY_SCRIPT to the rea.mjs entry (optionally
//      REA_PROXY_NODE to override the node binary) -> spawns node <script> --mcp
//   2) default:  spawns the `rea` CLI from PATH (npm i -g rea-agents, or a local
//      node_modules/.bin on PATH). On Windows `rea` is a .cmd shim, which Node
//      cannot pipe-spawn directly (EINVAL), so it is launched via the shell.
const REA_PROXY_SCRIPT = process.env.REA_PROXY_SCRIPT;
const spawnSpec = REA_PROXY_SCRIPT
  ? { command: process.env.REA_PROXY_NODE ?? 'node', args: [REA_PROXY_SCRIPT, '--mcp'], shell: false }
  : process.platform === 'win32'
    ? { command: 'rea --mcp', args: [], shell: true }
    : { command: 'rea', args: ['--mcp'], shell: false };

const LOADER_HINT =
  '\n\nREA tool loading is ON-DEMAND: NO analysis tools are exposed by default — only the 4 loader control tools ' +
  '(rea_tools_status / rea_tools_enable / rea_tools_disable / rea_tools_reset).\n' +
  'To use REA, first call mcp__rea__rea_tools_status to list domains and counts, then call\n' +
  'mcp__rea__rea_tools_enable with {"groups":["core","<domain>", ...]} (or ["all"]). Enabled tools appear immediately via list_changed.\n' +
  'Use rea_tools_disable / rea_tools_reset to hide them again.';

// ── Tool groups (exact rea tool names) ─────────────────────────────────────
const CORE = [
  'binary_session', 'open_binary', 'close_binary',
  'export_evidence_bundle', 'import_evidence_bundle', 'get_evidence_bundle',
  'list_unknowns', 'inspect_analysis_view',
  'get_navigation_context', 'inspect_address_context',
];

const GROUPS = {
  native: [
    'annotate_native_function', 'inspect_native_load_image', 'inspect_native_data_type',
    'inspect_native_instruction', 'resolve_native_call_targets', 'address_name', 'comment',
    'current_address', 'current_procedure', 'current_document', 'goto_address',
    'inline_comment', 'list_bookmarks', 'list_documents', 'list_names', 'list_procedures',
    'list_segments', 'list_strings', 'next_address', 'prev_address', 'procedure_address',
    'procedure_assembly', 'procedure_callees', 'procedure_callers', 'procedure_info',
    'read_function_instructions', 'read_bytes', 'address_to_file_offset',
    'procedure_references', 'procedure_pseudo_code', 'resolve_containing_procedure',
    'search_procedures', 'search_strings', 'set_address_name', 'set_addresses_names',
    'set_bookmark', 'set_comment', 'set_inline_comment', 'unset_bookmark', 'xrefs',
    'trace_native_values', 'inspect_native_dispatch_metadata', 'get_objc_classes',
    'get_objc_protocols', 'batch_decompile', 'get_call_graph', 'analyze_swift_types',
    'find_xrefs_to_name', 'binary_overview', 'analyze_function', 'inspect_native_api',
    'trace_feature', 'trace_call_path', 'trace_native_ui_action', 'demangle_swift',
    'inspect_binary_layout',
  ],
  apple: [
    'inspect_macho', 'inspect_signature', 'inspect_plist', 'list_architectures',
    'decode_interface_builder', 'inspect_keyed_archive', 'inspect_asset_catalog',
    'trace_dylib_resolution', 'project_apple_application_graph',
  ],
  managed: [
    'inspect_managed_artifact', 'inspect_managed_members', 'inspect_managed_native_boundaries',
    'compare_managed_members', 'verify_managed_native_boundaries',
    'import_managed_reconstruction', 'project_managed_application_graph',
  ],
  android: [
    'inspect_android_package', 'search_android_classes', 'inspect_android_class',
    'inspect_android_method', 'trace_android_references', 'inspect_jeb_client',
    'open_jeb_project', 'list_jeb_units', 'decompile_jeb_item', 'inspect_apktool_client',
    'decode_android_resources', 'project_android_application_graph',
  ],
  adb: [
    'inspect_adb_client', 'list_adb_devices', 'inspect_adb_device', 'list_adb_packages',
    'pull_adb_package', 'read_adb_logcat', 'inspect_adb_package', 'pull_adb_file',
    'push_adb_file', 'capture_adb_screen', 'list_adb_processes', 'list_adb_directory',
    'list_adb_features', 'list_adb_services', 'inspect_adb_display', 'inspect_adb_window',
    'read_adb_setting', 'collect_adb_bugreport', 'resolve_adb_packages',
    'install_adb_package', 'uninstall_adb_package', 'start_adb_app', 'start_adb_activity',
    'stop_adb_app',
  ],
  web: [
    'trace_web_module_imports', 'trace_web_source_location', 'observe_web_execution',
    'inspect_web_event_listeners', 'inspect_web_network_capture', 'list_browser_targets',
    'inspect_web_page', 'analyze_web_bundle', 'observe_web_session',
    'discover_webmcp_tools', 'compare_web_captures', 'capture_web_screenshot',
    'compare_web_screenshots', 'capture_browser_scenario',
  ],
  electron: [
    'list_electron_targets', 'inspect_electron_page', 'capture_electron_scenario',
  ],
  javascript: [
    'recover_javascript_sources', 'export_web_scripts', 'analyze_javascript_application',
    'reconcile_javascript_runtime', 'list_javascript_runtime_targets',
    'observe_javascript_runtime', 'trace_application_feature', 'trace_javascript_semantics',
    'compare_application_versions', 'compare_source_to_bundle',
    'compare_javascript_export_shapes',
  ],
  process: [
    'observe_native_ui', 'capture_native_ui_scenario', 'observe_native_calls',
    'capture_process_scenario', 'compare_process_captures',
  ],
  artifact: [
    'inspect_artifact', 'extract_artifact', 'inspect_pe_resources', 'inspect_evm_interface',
    'inspect_recorded_crash', 'inspect_firmware_regions', 'extract_firmware',
  ],
  reconstruction: [
    'build_reconstruction_obligation_ledger', 'evaluate_reconstruction_coverage',
    'verify_reconstruction', 'compare_artifacts', 'compare_functions', 'compare_bundles',
    'find_changed_behavior', 'build_call_path', 'correlate_static_and_runtime',
    'record_unknown', 'update_unknown', 'verify_unknown_resolution',
  ],
};

// ── Proxy control tools (always exposed — the only visible tools by default) ──
const ALL_GROUPS = ['core', ...Object.keys(GROUPS)]; // every loadable group, core included
const CONTROL = {
  rea_tools_status: {
    description:
      'REA on-demand loader: report which tool groups are currently enabled, ' +
      'tool counts, and how to load more. NO REA analysis tools are exposed by ' +
      'default — only these loader control tools. Enable a domain (core, native, ' +
      'javascript, web, android, adb, managed, apple, process, artifact, electron, ' +
      'reconstruction) with rea_tools_enable when you actually need those tools; ' +
      'DSH re-syncs the tool catalog live.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => statusText(),
  },
  rea_tools_enable: {
    description:
      'Enable one or more REA tool groups on demand, e.g. {"groups":["core","native","javascript"]} ' +
      'or ["all"]. The corresponding tools are then exposed to the agent immediately ' +
      '(DSH re-syncs on tools/list_changed). By default no analysis tools are loaded.',
    inputSchema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array', items: { type: 'string' },
          description: 'Group names to enable (core, native, apple, managed, android, adb, web, electron, javascript, process, artifact, reconstruction), or ["all"].',
        },
      },
      required: ['groups'],
    },
    run: async ({ groups }) => {
      const target = Array.isArray(groups) ? groups : [];
      let changed = false;
      for (const g of target) {
        const key = String(g);
        if (key === 'all') { for (const name of ALL_GROUPS) changed = enabled.add(name) || changed; }
        else if (ALL_GROUPS.includes(key)) changed = enabled.add(key) || changed;
        else return `unknown group "${g}". Run rea_tools_status for the list.`;
      }
      if (changed) notifyListChanged();
      return `enabled: ${target.join(', ')}\n\n${statusText()}`;
    },
  },
  rea_tools_disable: {
    description:
      'Disable REA tool groups to slim the catalog again. Pass group names, ' +
      'e.g. {"groups":["native"]}. Disabling every group leaves only the loader ' +
      'control tools visible.',
    inputSchema: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: { type: 'string' }, description: 'Group names to disable.' },
      },
      required: ['groups'],
    },
    run: async ({ groups }) => {
      let changed = false;
      for (const g of Array.isArray(groups) ? groups : []) {
        if (ALL_GROUPS.includes(String(g))) changed = enabled.delete(String(g)) || changed;
      }
      if (changed) notifyListChanged();
      return statusText();
    },
  },
  rea_tools_reset: {
    description: 'Reset REA to the default on-demand state: no analysis tools exposed (loader control tools only).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      enabled.clear();
      notifyListChanged();
      return statusText();
    },
  },
};

// ── State ──────────────────────────────────────────────────────────────────
const enabled = new Set(); // empty => only the control tools are visible
const groupOf = new Map(); // toolName -> group
let fullTools = null;
let warmPromise = null;

const internal = new Map(); // warm-up request ids -> {resolve,reject}
const INTERNAL_ID_BASE = 900000;
let internalSeq = 0;
const initializeIds = new Set(); // client ids whose responses need the loader hint

// Protocol 2026-07-28+ envelope captured from the client's requests, replayed
// on our internal requests to the real server (rea enforces it) and required
// on our own responses (`resultType: "complete"`).
let clientMeta = null;

buildGroupIndex(); // populate groupOf (after the maps above are declared)

function buildGroupIndex() {
  for (const [group, names] of Object.entries(GROUPS)) {
    for (const n of names) groupOf.set(n, group);
  }
  for (const n of CORE) groupOf.set(n, 'core');
}

function notifyListChanged() {
  writeLine({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

function statusText() {
  const lines = ['REA on-demand loader status', '-------------------------------'];
  for (const name of ALL_GROUPS) {
    const count = name === 'core' ? CORE.length : GROUPS[name].length;
    lines.push(`${enabled.has(name) ? '[ON ]' : '[off]'} ${name.padEnd(14)} ${count} tools`);
  }
  lines.push('-------------------------------');
  lines.push('No analysis tools are exposed by default — only the 4 loader controls.');
  lines.push('Enable a domain with: rea_tools_enable {groups:["<group>", ...]}');
  lines.push('e.g. {"groups":["core","javascript"]} for session + JS/Electron analysis,');
  lines.push('{"groups":["native"]} for binary analysis, or {"groups":["all"]}.');
  lines.push('Disable / reset with rea_tools_disable / rea_tools_reset.');
  return lines.join('\n');
}

function controlToolDefinition(name) {
  const c = CONTROL[name];
  return { name, description: c.description, inputSchema: c.inputSchema };
}

function writeLine(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
}

// ── Real server child ──────────────────────────────────────────────────────
const child = spawn(spawnSpec.command, spawnSpec.args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  shell: spawnSpec.shell ?? false,
});
child.stderr.on('data', (d) => process.stderr.write(d));

// Single handler on the real server's stdout:
//  - internal warm-up responses are consumed (never relayed to the client)
//  - initialize responses get the loader hint injected
//  - everything else is relayed verbatim
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }

  if (msg.id !== undefined && internal.has(msg.id)) {
    const p = internal.get(msg.id);
    internal.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    return; // consumed internally
  }

  if (msg.id !== undefined && initializeIds.has(msg.id)) {
    initializeIds.delete(msg.id);
    if (msg.result && typeof msg.result.instructions === 'string') {
      msg.result.instructions += LOADER_HINT;
    }
    // rea has now fully processed the client's initialize. Warm the catalog
    // from this point: the first client tools/list can be answered from cache.
    // Do NOT gate on notifications/initialized — modern MCP SDK clients
    // (protocol 2026-07-28+) use subscriptions/listen and may never send it.
    warmCatalog();
  }

  writeLine(msg);
});

// ── Warm-up the full catalog (after the real server answered initialize) ───
function warmCatalog() {
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    const id = INTERNAL_ID_BASE + (++internalSeq);
    const p = new Promise((resolve, reject) => internal.set(id, { resolve, reject }));
    const params = clientMeta ? { _meta: clientMeta } : {};
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params }) + '\n');
    try {
      const res = await p;
      fullTools = Array.isArray(res) ? res : (res?.tools ?? []);
    } catch (e) {
      fullTools = [];
      process.stderr.write(`rea-proxy: warm-up tools/list failed: ${String(e?.message ?? e)}\n`);
    }
    verifyCoverage();
    return fullTools;
  })();
  return warmPromise;
}

function verifyCoverage() {
  const assigned = new Set();
  for (const t of fullTools ?? []) {
    const g = groupOf.get(t.name);
    if (!g) process.stderr.write(`rea-proxy: UNASSIGNED tool "${t.name}" — rea upgraded? add it to a group in rea-mcp-proxy.mjs\n`);
    assigned.add(t.name);
  }
  const groupsTotal = CORE.length + Object.values(GROUPS).reduce((a, n) => a + n.length, 0);
  process.stderr.write(
    `rea-proxy: catalog=${fullTools?.length ?? 0} rea tools | mapped=${assigned.size}/${groupsTotal} | ` +
    `default enabled=core(${CORE.length}) + control(${Object.keys(CONTROL).length})\n`,
  );
}

// ── Client request handling ────────────────────────────────────────────────
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  // Capture the client's protocol-2026 envelope (protocolVersion + client
  // capabilities) from whichever request carries it, so our internal requests
  // to the real server can mirror it.
  if (params && typeof params === 'object' && params._meta && typeof params._meta === 'object') {
    clientMeta = params._meta;
  }

  if (method === 'tools/list') {
    const all = (await warmCatalog()) ?? [];
    // Only enabled groups are exposed. By default `enabled` is empty, so the
    // catalog carries just the loader control tools (zero analysis tools).
    const visible = all.filter((t) => {
      const g = groupOf.get(t.name);
      return g !== undefined && enabled.has(g);
    });
    const tools = [...visible, ...Object.keys(CONTROL).map(controlToolDefinition)];
    // Protocol 2026-07-28 requires resultType/ttlMs/cacheScope on list results;
    // legacy clients ignore the extra fields.
    writeLine({ jsonrpc: '2.0', id, result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools } });
    return;
  }

  if (method === 'tools/call' && params && Object.prototype.hasOwnProperty.call(CONTROL, params.name)) {
    const c = CONTROL[params.name];
    Promise.resolve(c.run(params.arguments ?? {}))
      .then((text) => writeLine({ jsonrpc: '2.0', id, result: { resultType: 'complete', content: [{ type: 'text', text }] } }))
      .catch((err) => writeLine({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } }));
    return;
  }

  if (method === 'initialize') {
    initializeIds.add(id);
    child.stdin.write(line + '\n');
    return;
  }

  // all other notifications and requests -> transparent relay
  child.stdin.write(line + '\n');
});

// ── Shutdown hygiene ───────────────────────────────────────────────────────
process.stdin.resume();
process.on('SIGTERM', () => { child.kill(); process.exit(0); });
process.on('SIGINT', () => { child.kill(); process.exit(0); });
