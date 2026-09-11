import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

const packageId = 'dsh-agent-control-plugin'
const virtualPrefix = '\0agent-control-css:'
const virtualSuffix = '.mjs'

function scopedCss(source: string): { css: string; classes: Record<string, string> } {
  const names = new Set([...source.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)].map(match => match[1]!))
  const classes: Record<string, string> = {}
  let css = source
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const scoped = `dac_${name}`
    classes[name] = scoped
    css = css.replace(new RegExp(`\\.${name}(?![A-Za-z0-9_-])`, 'g'), `.${scoped}`)
  }
  return { css, classes }
}

const host: UserConfig = {
  name: packageId,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22.19.0',
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@deepseek-ai\//],
}

const client: UserConfig = {
  name: `${packageId}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  external: [/^@deepseek-ai\//, /^react(?:\/.*)?$/],
  plugins: [{
    name: 'agent-control-css-inline',
    resolveId(source: string, importer?: string) {
      if (!source.endsWith('.module.css')) return null
      return virtualPrefix + (importer ? resolve(dirname(importer), source) : source) + virtualSuffix
    },
    async load(id: string) {
      if (!id.startsWith(virtualPrefix)) return null
      const file = id.slice(virtualPrefix.length, -virtualSuffix.length)
      this.addWatchFile(file)
      const { css, classes } = scopedCss(await readFile(file, 'utf8'))
      return [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(`${packageId}/workspace`)};`,
        "if (typeof document !== 'undefined') {",
        "  const tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') ?? document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(packageId)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  if (!tag.isConnected) document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default defineConfig([host, client])
