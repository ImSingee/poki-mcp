// MCP Apps views (https://modelcontextprotocol.io/extensions/apps): static HTML pages a host such as
// LobeHub or Codex renders in a sandboxed iframe next to a tool's result. Each page in this directory
// is self-contained; the ext-apps App bundle is inlined into it when the resource is read, so there is
// no bundler and nothing to build. The stdio shim and the daemon both answer resources/list and
// resources/read from here (tools.mjs), so a host can load a view before any daemon runs.
//
// A view's HTML holds the marker <!-- poki:ext-apps -->. It becomes a module script that publishes
// the bundle's exports as globalThis.PokiExtApps; the page's own module script, which follows it in
// document order, runs after it.
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Parser } from 'acorn';

export const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const marker = '<!-- poki:ext-apps -->';
const require = createRequire(import.meta.url);

// uri, page file, and the resource's _meta.ui (csp, border). Views make no network requests of
// their own: every call goes through the host to the tools.
export const views = [
  {
    uri: 'ui://poki/pairing', name: 'poki-pairing', file: 'pairing.html',
    title: 'iPhone pairing', description: 'Pair an iPhone over Wi-Fi, show its PIN, and manage paired devices.',
    meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  },
];

// _meta for tools that a view opens or calls. ui.visibility: "model" (the agent may call it), "app"
// (a view may call it). lobehub/ui.preferredModelDisplayMode picks inline or the side panel there.
export const toolMeta = {
  pair_device: { ui: { resourceUri: 'ui://poki/pairing', visibility: ['model', 'app'] }, 'ui/resourceUri': 'ui://poki/pairing', 'lobehub/ui': { preferredModelDisplayMode: 'inline' } },
  pairing_status: { ui: { visibility: ['model', 'app'] } },
  pairing_cancel: { ui: { visibility: ['app'] } },
  unpair_device: { ui: { visibility: ['model', 'app'] } },
  list_devices: { ui: { visibility: ['model', 'app'] } },
};

// Rewrites the bundle's final `export { local as Name, ... }` into an assignment to globalThis, so it
// runs as an inline module script that later scripts can use. Any other export form is refused: the
// rewrite would silently drop it.
export function exportsAsGlobal(source, name = 'PokiExtApps') {
  if (/<\/script|<!--/i.test(source)) throw new Error('The ext-apps bundle contains </script or <!--, which would end an inline script early.');
  const program = Parser.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const exports = program.body.filter(node => node.type.startsWith('Export'));
  if (exports.length !== 1 || exports[0].type !== 'ExportNamedDeclaration' || exports[0].declaration || exports[0].source) throw new Error('Unexpected export form in the ext-apps bundle.');
  const [node] = exports;
  const entries = node.specifiers.map(spec => `${JSON.stringify(spec.exported.name ?? spec.exported.value)}:${spec.local.name}`);
  return `${source.slice(0, node.start)}globalThis.${name}=Object.freeze({${entries.join(',')}});${source.slice(node.end)}`;
}

let bundle;
async function appBundle() {
  const file = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
  const { mtimeMs } = await stat(file);
  if (bundle?.mtimeMs !== mtimeMs) bundle = { mtimeMs, script: exportsAsGlobal(await readFile(file, 'utf8')) };
  return bundle.script;
}

export const viewFor = uri => views.find(view => view.uri === uri);

export async function renderView(view) {
  const html = await readFile(fileURLToPath(new URL(view.file, import.meta.url)), 'utf8');
  if (!html.includes(marker)) throw new Error(`${view.file} has no ${marker} marker.`);
  const script = await appBundle();
  return html.replace(marker, () => `<script type="module">${script}</script>`);
}

export async function readView(uri) {
  const view = viewFor(uri);
  if (!view) throw Object.assign(new Error(`Unknown resource ${uri}.`), { code: -32002 });
  return { contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: await renderView(view), _meta: view.meta }] };
}
