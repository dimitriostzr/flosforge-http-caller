import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { Settings } from '@shared/types'
import { openSecrets, sealSecrets, type SecretCipher } from '../src/main/secrets'

const rot = (s: string): string => s.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97))
const cipher = (available = true): SecretCipher => ({
  available: () => available,
  encrypt: (t) => Buffer.from(rot(t)).toString('base64'),
  decrypt: (b) => rot(Buffer.from(b, 'base64').toString())
})
const settings = (): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  proxy: { mode: 'custom', url: 'http://proxy:3128', username: 'me', password: 'hunter2', bypass: '' },
  certificates: {
    useSystemCa: false,
    caPaths: [],
    client: [
      { id: 'a', enabled: true, host: 'api.test', certPath: '', keyPath: '', pfxPath: '/x.p12', passphrase: 'pass' },
      { id: 'b', enabled: true, host: 'b.test', certPath: '/c.pem', keyPath: '/k.pem', pfxPath: '', passphrase: '' }
    ]
  }
})

describe('settings secrets', () => {
  it('are encrypted on disk and plain again in memory', () => {
    const sealed = sealSecrets(settings(), cipher()) as unknown as { proxy: Record<string, string>; certificates: { client: Record<string, string>[] } }
    expect(sealed.proxy.password).toBe('')
    expect(sealed.proxy.passwordEncrypted).toBe(Buffer.from('uhagre2').toString('base64'))
    expect(sealed.certificates.client[0].passphrase).toBe('')
    expect(sealed.certificates.client[0].passphraseEncrypted).toBeTruthy()
    expect('passphraseEncrypted' in sealed.certificates.client[1]).toBe(false)
    expect(JSON.stringify(sealed)).not.toContain('hunter2')

    const opened = openSecrets(sealed as unknown as Settings, cipher())
    expect(opened).toEqual(settings())
    expect('passwordEncrypted' in opened.proxy).toBe(false)
  })

  it('stay plain without a keychain, and survive a keychain that cannot decrypt', () => {
    const plain = sealSecrets(settings(), cipher(false))
    expect(plain).toEqual(settings())

    const sealed = sealSecrets(settings(), cipher())
    const lost = openSecrets(sealed, { ...cipher(), decrypt: () => { throw new Error('no key') } })
    expect(lost.proxy.password).toBe('')
    expect(lost.certificates.client[0].passphrase).toBe('')
    const none = openSecrets(sealed, cipher(false))
    expect(none.proxy.password).toBe('')
  })

  it('prefers a value typed into the file by hand', () => {
    const sealed = sealSecrets(settings(), cipher())
    sealed.proxy.password = 'typed'
    expect(openSecrets(sealed, cipher()).proxy.password).toBe('typed')
  })
})
