// Lists the third-party software that ships inside the app, with each license.
//
// Starts from every package imported anywhere in src/, follows their
// dependencies (and installed peer dependencies) through node_modules, and
// writes:
//   THIRD_PARTY_NOTICES.md                     for the repository
//   src/renderer/src/about/thirdParty.json     for the app's About screen
//
// Erring on the side of listing too much is fine (a package that is tree-shaken
// away still gets credited); listing too little is not. Runs before every build.
//
//   node scripts/third-party.mjs          regenerate
//   node scripts/third-party.mjs --check  fail if the committed files are stale

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nm = join(root, 'node_modules')
const MD_OUT = join(root, 'THIRD_PARTY_NOTICES.md')
const JSON_OUT = join(root, 'src/renderer/src/about/thirdParty.json')

// Path aliases from electron.vite.config.ts, not packages.
const ALIASES = ['@shared', '@renderer']
// Shipped but not imported by name: the runtime itself.
const EXTRA_ROOTS = ['electron']
// The npm package's dependencies only download the runtime; none of them ship.
const LEAVES = new Set(['electron'])

// Third-party data bundled inside a package, under a license of its own.
const EMBEDDED = [
  {
    name: 'Public Suffix List',
    version: 'as bundled in tldts',
    license: 'MPL-2.0',
    author: 'Mozilla Foundation and contributors',
    url: 'https://publicsuffix.org',
    text:
      'Embedded as data in tldts (used by tough-cookie for the cookie jar). Source form: ' +
      'https://github.com/publicsuffix/list\n\n' +
      readFileSync(join(root, 'scripts/licenses/MPL-2.0.txt'), 'utf8').trim()
  }
]

// Painted themes that reuse another theme's colour values. Colours aren't code and
// none of their source is included, but the palettes are theirs, so they are credited.
// Keep in step with src/renderer/src/theme/themes.ts.
const PALETTES = [
  { themes: ['Hothouse'], from: 'Monokai', author: 'Wimer Hazenberg', url: 'https://monokai.nl' },
  { themes: ['Fjord', 'Fjord Light'], from: 'Nord', author: 'Sven Greb (Arctic Ice Studio)', url: 'https://www.nordtheme.com' },
  { themes: ['Vesper'], from: 'Dracula', author: 'Zeno Rocha', url: 'https://draculatheme.com' },
  { themes: ['Meridian', 'Meridian Light'], from: 'Solarized', author: 'Ethan Schoonover', url: 'https://ethanschoonover.com/solarized/' },
  { themes: ['Bracken', 'Bracken Light'], from: 'gruvbox', author: 'Pavel Pertsev', url: 'https://github.com/morhetz/gruvbox' },
  { themes: ['Indigo Night'], from: 'Tokyo Night', author: 'enkia', url: 'https://github.com/enkia/tokyo-night-vscode-theme' },
  { themes: ['Slate'], from: 'One Dark', author: 'the Atom team (GitHub)', url: 'https://github.com/atom/atom' },
  { themes: ['Praline', 'Praline Light'], from: 'Catppuccin (Mocha, Latte)', author: 'Catppuccin', url: 'https://catppuccin.com' },
  { themes: ['Rosewood', 'Rosewood Dawn'], from: 'Rosé Pine', author: 'Rosé Pine', url: 'https://rosepinetheme.com' },
  { themes: ['Everglade'], from: 'Everforest', author: 'sainnhe', url: 'https://github.com/sainnhe/everforest' },
  { themes: ['Ember Dark', 'Ember Light'], from: 'Ayu', author: 'Ike Ku and contributors', url: 'https://github.com/ayu-theme' },
  { themes: ['Repo Dark', 'Repo Light'], from: 'GitHub Primer colours', author: 'GitHub', url: 'https://primer.style' },
  { themes: ['Retrowave'], from: "SynthWave '84", author: 'Robb Owen', url: 'https://github.com/robb0wen/synthwave-vscode' },
  { themes: ['Ink Wash'], from: 'Kanagawa', author: 'Tommaso Laurenzi', url: 'https://github.com/rebelot/kanagawa.nvim' },
  { themes: ['Olivewood'], from: 'Zenburn', author: 'Jani Nurminen', url: 'https://github.com/jnurmine/Zenburn' },
  { themes: ['Cobalt'], from: 'Cobalt2', author: 'Wes Bos', url: 'https://github.com/wesbos/cobalt2-vscode' },
  { themes: ['Small Hours'], from: 'Night Owl', author: 'Sarah Drasner', url: 'https://github.com/sdras/night-owl-vscode-theme' },
  { themes: ['Hoarfrost'], from: 'Poimandres', author: 'drcmda', url: 'https://github.com/drcmda/poimandres-theme' },
  { themes: ['Deep Ocean', 'Dusklight'], from: 'Material Theme (Ocean, Palenight)', author: 'Mattia Astorino', url: 'https://github.com/material-theme/vsc-material-theme' },
  { themes: ['Tidewater'], from: 'Oceanic Next', author: 'Dmitri Voronianski', url: 'https://github.com/voronianski/oceanic-next-color-scheme' },
  { themes: ['Horizon'], from: 'Horizon', author: 'Jonathan Olaleye', url: 'https://github.com/jolaleye/horizon-theme-vscode' },
  { themes: ['Nightfall'], from: 'Tomorrow Night', author: 'Chris Kempson', url: 'https://github.com/chriskempson/tomorrow-theme' },
  { themes: ['Iceberg'], from: 'Iceberg', author: 'cocopon', url: 'https://github.com/cocopon/iceberg.vim' },
  { themes: ['Bluejay'], from: 'Nightfox', author: 'EdenEast', url: 'https://github.com/EdenEast/nightfox.nvim' },
  { themes: ['Sparse', 'Sparse Light'], from: 'Vitesse', author: 'Anthony Fu', url: 'https://github.com/antfu/vscode-theme-vitesse' }
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(m?[jt]sx?|cjs)$/.test(name)) out.push(p)
  }
  return out
}

/** 'lodash/fp' → 'lodash', '@codemirror/view/x' → '@codemirror/view'. */
const packageOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])

function importedPackages() {
  const found = new Set(EXTRA_ROOTS)
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"./][^'"]*)['"]/g
  for (const file of walk(join(root, 'src'))) {
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(re)) {
      if (spec.startsWith('node:') || builtinModules.includes(spec)) continue
      const pkg = packageOf(spec)
      if (ALIASES.includes(pkg) || pkg.startsWith('@types/')) continue
      found.add(pkg)
    }
  }
  return found
}

/** Finds a package from the directory of the package that depends on it, as Node resolves it. */
function locate(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return dirname(candidate)
    if (dir === root || dir === dirname(dir)) return null
  }
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i

function licenseText(dir) {
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort((a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || a.localeCompare(b))
  return files.map((f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()).join('\n\n') || null
}

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/** Some packages declare MIT but leave the file out of what they publish to npm. */
function fallbackText(license, author) {
  if (license !== 'MIT') return null
  return [
    '(The published package has no license file. Standard MIT License text, with the copyright holder named in',
    'its package.json.)',
    '',
    'MIT License',
    '',
    `Copyright (c) ${author ?? 'the package authors'}`,
    '',
    MIT_TEXT
  ].join('\n')
}

const spdx = (pkg) =>
  typeof pkg.license === 'string'
    ? pkg.license
    : (pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : 'UNKNOWN'))

const repoUrl = (pkg) => {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!r) return pkg.homepage ?? null
  return r
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^(?!https?:)([\w-]+\/[\w.-]+)$/, 'https://github.com/$1')
}

const authorOf = (pkg) => (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name) ?? null

function collect() {
  const seen = new Map()
  const queue = [...importedPackages()].map((name) => ({ name, from: root }))
  while (queue.length) {
    const { name, from } = queue.shift()
    const dir = locate(name, from)
    if (!dir) {
      // Optional or uninstalled peer dependencies are not shipped.
      continue
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const key = `${pkg.name}@${pkg.version}`
    if (seen.has(key)) continue
    seen.set(key, {
      name: pkg.name,
      version: pkg.version,
      license: spdx(pkg),
      author: authorOf(pkg),
      url: repoUrl(pkg),
      text: licenseText(dir) ?? fallbackText(spdx(pkg), authorOf(pkg)),
      dir: relative(root, dir)
    })
    if (LEAVES.has(pkg.name)) continue
    const next = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }
    for (const dep of Object.keys(next)) if (!dep.startsWith('@types/')) queue.push({ name: dep, from: dir })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

const packages = [...collect(), ...EMBEDDED]
const missing = packages.filter((p) => !p.text)
if (missing.length) {
  console.error('No license file found for:\n' + missing.map((p) => `  ${p.name}@${p.version} (${p.dir})`).join('\n'))
  process.exit(1)
}

const md = [
  '# Third-party notices',
  '',
  'FlosForge Caller includes the open-source software listed below. Each component is distributed under its own',
  'license, reproduced in full in this file. This list is generated by `scripts/third-party.mjs` from the packages',
  'the app actually imports and everything they depend on.',
  '',
  'The app also ships with **Electron**, which contains **Chromium** and **Node.js**. Their licenses, and those of',
  'the libraries they include, come with every copy of the app as `LICENSES.chromium.html` (open it from',
  '**Settings → About**) and are published at <https://github.com/electron/electron>.',
  '',
  '## Software',
  '',
  '| Package | Version | License |',
  '|---|---|---|',
  ...packages.map((p) => `| ${p.url ? `[${p.name}](${p.url})` : p.name} | ${p.version} | ${p.license} |`),
  '',
  '## Theme palettes',
  '',
  'Several painted themes reuse the colour values of these themes (no code from them is included). Credit to their',
  'authors:',
  '',
  ...PALETTES.map((t) => `- ${t.themes.join(', ')}: colours from [${t.from}](${t.url}) by ${t.author}`),
  '',
  '## License texts',
  '',
  ...packages.flatMap((p) => [
    `### ${p.name} ${p.version}`,
    '',
    `License: ${p.license}${p.author ? ` · Author: ${p.author}` : ''}${p.url ? ` · ${p.url}` : ''}`,
    '',
    '```text',
    p.text.replace(/```/g, "'''"),
    '```',
    ''
  ])
].join('\n')

const json = JSON.stringify({ packages: packages.map(({ dir: _dir, ...p }) => p), palettes: PALETTES }, null, 1) + '\n'

if (process.argv.includes('--check')) {
  const stale = [
    [MD_OUT, md],
    [JSON_OUT, json]
  ].filter(([f, content]) => !existsSync(f) || readFileSync(f, 'utf8') !== content)
  if (stale.length) {
    console.error('Third-party notices are out of date. Run: node scripts/third-party.mjs')
    process.exit(1)
  }
} else {
  writeFileSync(MD_OUT, md)
  writeFileSync(JSON_OUT, json)
  const byLicense = {}
  for (const p of packages) byLicense[p.license] = (byLicense[p.license] ?? 0) + 1
  console.log(`${packages.length} packages:`, byLicense)
}
