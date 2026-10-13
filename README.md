# rea-mcp-on-demand-loader

**On-demand (lazy) tool loading for the [REA](https://github.com/morluto/rea) MCP server.**

REA (Reverse Engineer Anything) exposes **170+ MCP tools** for reverse engineering —
native binaries, JavaScript/Electron apps, .NET assemblies, Android/ADB, web captures,
firmware, and more. Mounting all of them into an agent's tool catalog at once is heavy:
huge schemas, token cost on every tool listing, and noise for the model.

This project is a tiny **MCP proxy** that sits between your MCP client and REA. It only
exposes a small curated **core** set plus four control tools. When the agent actually
needs a domain, it calls a control tool to enable that group, and the new tools appear
**live** — no restart, no reconfiguration.

> Works with any MCP client that honors `notifications/tools/list_changed`
> (e.g. DeepSeek Harness / DSH, where the mechanism is identical to the built-in
> godot-mcp toolset).

---

## How it works

```
MCP client (agent)  ⇄  rea-mcp-proxy.mjs (filters tools/list, relays everything else)
                              ⇄  real `rea --mcp` server (170+ tools)
```

- The proxy spawns the real REA server and relays all traffic transparently.
- It intercepts `tools/list` and returns **only the currently enabled groups** plus
  4 control tools.
- When the agent toggles a group via a control tool, the proxy emits
  `notifications/tools/list_changed`; a compliant client (DSH included) re-fetches
  `tools/list` and the newly enabled tools appear immediately.
- Tool-group assignment is explicit and verified at startup: if a `rea-agents` upgrade
  adds or renames a tool, the proxy warns instead of silently dropping it.

**Default exposure: zero analysis tools** — only the 4 loader control tools
(`rea_tools_status` / `rea_tools_enable` / `rea_tools_disable` / `rea_tools_reset`)
are visible. All 170+ REA tools — `core` included — load on demand.

### Control tools (always visible)

| Tool | Effect |
|---|---|
| `rea_tools_status` | Show which groups are enabled, tool counts, and how to load more. |
| `rea_tools_enable` | Enable group(s): `{"groups":["core","native","javascript"]}` or `["all"]`. |
| `rea_tools_disable` | Disable group(s): `{"groups":["web"]}`. |
| `rea_tools_reset` | Back to default: no analysis tools exposed. |

### Tool groups

| Group | Tools | Domain |
|---|---|---|
| **core** | 10 | session / evidence bundle / navigation basics |
| native | 56 | functions, assembly, pseudo-code, strings, symbols, xrefs, decompile, ObjC/Swift |
| apple | 9 | Mach-O, signature, plist, asset catalog, interface builder, dylib |
| managed | 7 | .NET PE/CLI members & reconstruction |
| android | 12 | APK/DEX/JEB/apktool analysis & graph projection |
| adb | 24 | device, packages, processes, logcat, push/pull, screen |
| web | 14 | browser/CDP, page bundles, network capture |
| electron | 3 | Electron targets, page, scenario |
| javascript | 11 | static JS/Electron analysis, app graphs, version compare |
| process | 5 | process scenario capture, native UI observation |
| artifact | 7 | artifact, PE resources, EVM, firmware, crash |
| reconstruction | 12 | reconstruction obligation ledger, coverage, verification |

---

## Requirements

- Node.js `>=20.12` (the proxy itself); REA requires `^22.19.0 || ^24.11.0 || >=26.0.0`.
- [`rea-agents`](https://www.npmjs.com/package/rea-agents) installed:
  `npm install --global rea-agents` (or any install that puts the `rea` CLI on PATH).

> Native binary analysis additionally needs Hopper / Ghidra / IDA. Static
> JS/Electron/Web analysis and the rest work out of the box.

---

## Usage

### 1. Run the proxy as an MCP server

```bash
node rea-mcp-proxy.mjs
```

By default the proxy launches the `rea` CLI from PATH (`rea --mcp`). On Windows the
`.cmd` shim is launched via the shell automatically.

For a custom install (e.g. a local `node_modules`), point it at the exact binary:

```bash
REA_PROXY_NODE=/path/to/node \
REA_PROXY_SCRIPT=/path/to/rea-agents/scripts/rea.mjs \
node rea-mcp-proxy.mjs
```

Environment:

| Variable | Meaning |
|---|---|
| `REA_PROXY_SCRIPT` | Absolute path to `rea.mjs`. When set, the proxy runs `node <script> --mcp` instead of `rea --mcp`. |
| `REA_PROXY_NODE` | Node binary to use with `REA_PROXY_SCRIPT` (default: `node`). |

### 2. Register it in your MCP client

**DeepSeek Harness (DSH)** — add to `cordis.patch.yml` (desktop/web profile):

```yaml
- insert:
    - id: mcp-rea
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rea
        transport: stdio
        command: node
        args:
          - /abs/path/to/rea-mcp-proxy.mjs
        env:
          REA_PROXY_SCRIPT: /abs/path/to/rea-agents/scripts/rea.mjs   # optional
        toolCallTimeoutMs: 600000
```

Other MCP clients: register `node <abs>/rea-mcp-proxy.mjs` as a stdio MCP server.

### 3. Use it

The agent sees only the 4 loader control tools by default (zero analysis tools).
To analyze a domain it should:

1. `rea_tools_status` — see what's on and how to load more;
2. `rea_tools_enable` `{"groups":["core","javascript"]}` — tools appear immediately;
3. `rea_tools_disable` / `rea_tools_reset` — slim the catalog again when done.

---

## Test

```bash
node test-proxy.mjs
```

Runs a full simulated client session against the proxy (16 assertions):
initialize → default 4 control tools (no analysis tools) → enable `core`+`javascript`
→ `list_changed` → 25 tools → real tool call relayed to REA → disable → reset (back to 4)
→ enable all (174).

---

## Notes / limitations

- REA's server itself does **not** support tool filtering — that is why a proxy is
  needed (there is no upstream patch involved).
- Group membership is explicit; after upgrading `rea-agents`, re-run the test and add
  any `UNASSIGNED tool ...` warnings to `GROUPS`/`CORE` in the proxy.
- The 6 REA prompts are forwarded as-is.

## License

[MIT](LICENSE) © LZMW

Built for use with [morluto/rea](https://github.com/morluto/rea) (MIT). Not affiliated
with the REA project.
