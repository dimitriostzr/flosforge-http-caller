import { useEffect, useState } from 'react'
import { ExternalLink, FileText, Scale } from 'lucide-react'
import { APP_COPYRIGHT, APP_NAME, SOURCE_URL } from '@shared/app'
import { LogoMark } from '../sidebar/Sidebar'

// The legal notices the GPL asks an interactive program to show (copyright, no
// warranty, where the license and source are), plus every third-party component
// that ships inside the app. The lists come from scripts/third-party.mjs.

interface ThirdPartyPackage {
  name: string
  version: string
  license: string
  author: string | null
  url: string | null
  text: string
}
interface PaletteCredit {
  themes: string[]
  from: string
  author: string
  url: string
}
interface Notices {
  packages: ThirdPartyPackage[]
  palettes: PaletteCredit[]
}

const open = (url: string) => () => void window.api.openExternal(url)

export function AboutSettings({ version }: { version?: string }) {
  const [notices, setNotices] = useState<Notices | null>(null)
  const [license, setLicense] = useState<string | null>(null)
  const [showLicense, setShowLicense] = useState(false)

  // Loaded on demand so the license texts stay out of the startup bundle.
  useEffect(() => {
    void import('../../about/thirdParty.json').then((m) => setNotices(m.default as Notices))
  }, [])
  useEffect(() => {
    if (showLicense && license === null) void import('../../../../../LICENSE?raw').then((m) => setLicense(m.default))
  }, [showLicense, license])

  return (
    <div className="settings-grid about-pane">
      <section className="about">
        <LogoMark size={44} />
        <div>
          <div className="about-name">
            {APP_NAME} <span className="muted small">{version}</span>
          </div>
          <div className="muted small">Free, open-source, local-first API client from FlosForge.</div>
          <div className="muted small">{APP_COPYRIGHT}</div>
        </div>
      </section>

      <section>
        <h4>License</h4>
        <p className="hint">
          {APP_NAME} is free software: you can redistribute it and/or modify it under the terms of the GNU General
          Public License as published by the Free Software Foundation, either version 3 of the License, or (at your
          option) any later version. It comes with <strong>absolutely no warranty</strong>; see the license for
          details. The source code is available from the project page.
        </p>
        <div className="row-gap">
          <button className="btn secondary small" onClick={() => setShowLicense(!showLicense)}>
            <Scale size={14} /> {showLicense ? 'Hide license' : 'View license'}
          </button>
          <button className="btn secondary small" onClick={open(SOURCE_URL)}>
            <ExternalLink size={14} /> Source code
          </button>
        </div>
        {showLicense && <pre className="license-text">{license ?? 'Loading…'}</pre>}
      </section>

      <section>
        <h4>Open-source software</h4>
        <p className="hint">
          {APP_NAME} is built on the open-source software below. Click an entry to read its license.
        </p>
        <div className="row-gap">
          <button className="btn secondary small" onClick={() => void window.api.openRuntimeLicenses()}>
            <FileText size={14} /> Electron, Chromium and Node.js licenses
          </button>
        </div>
        <div className="notice-list">
          {notices?.packages.map((p) => (
            <details key={`${p.name}@${p.version}`} className="notice">
              <summary>
                <span className="notice-name">{p.name}</span>
                <span className="muted small">{p.version}</span>
                <span className="notice-license">{p.license}</span>
                {p.author && <span className="muted small notice-author">{p.author.replace(/\s*[<(][^>)]*[>)]/g, '')}</span>}
              </summary>
              {p.url && (
                <button className="link small" onClick={open(p.url)}>
                  {p.url}
                </button>
              )}
              <pre className="license-text">{p.text}</pre>
            </details>
          ))}
        </div>
      </section>

      <section>
        <h4>Theme palettes</h4>
        <p className="hint">Several painted themes reuse the colours of these themes. Credit to their authors:</p>
        <ul className="palette-credits">
          {notices?.palettes.map((t) => (
            <li key={t.from}>
              <span>{t.themes.join(', ')}</span>
              <span className="muted"> — colours from </span>
              <button className="link" onClick={open(t.url)}>
                {t.from}
              </button>
              <span className="muted"> by {t.author}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4>Trademarks</h4>
        <p className="hint">
          {APP_NAME} is an independent project, not affiliated with, endorsed by, or sponsored by any other API tool
          vendor. Product and company names are trademarks of their respective owners.
        </p>
      </section>
    </div>
  )
}
