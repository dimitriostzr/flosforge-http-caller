import type { Settings } from '@shared/types'

// Settings hold two kinds of credential: the proxy password and the passphrases
// of client certificates. On disk they are encrypted with the operating system's
// keychain (Electron's safeStorage) and stored as `<field>Encrypted`, base64, with
// the plain field left empty. In memory, and over IPC to the UI, the plain field
// is filled in again. Without a keychain the plain field is written as it is.

export interface SecretCipher {
  available(): boolean
  /** Base64 of the encrypted text. */
  encrypt(text: string): string
  decrypt(base64: string): string
}

const SUFFIX = 'Encrypted'

/** The settings as they are written to disk. */
export function sealSecrets(settings: Settings, cipher: SecretCipher): Settings {
  const out = structuredClone(settings)
  seal(out.proxy as unknown as Record<string, unknown>, 'password', cipher)
  for (const cert of out.certificates.client) seal(cert as unknown as Record<string, unknown>, 'passphrase', cipher)
  return out
}

/** The settings as the app uses them, read back from disk. */
export function openSecrets(settings: Settings, cipher: SecretCipher): Settings {
  const out = structuredClone(settings)
  open(out.proxy as unknown as Record<string, unknown>, 'password', cipher)
  for (const cert of out.certificates.client) open(cert as unknown as Record<string, unknown>, 'passphrase', cipher)
  return out
}

function seal(o: Record<string, unknown>, field: string, cipher: SecretCipher): void {
  const value = o[field]
  if (typeof value === 'string' && value && cipher.available()) {
    o[`${field}${SUFFIX}`] = cipher.encrypt(value)
    o[field] = ''
  } else {
    delete o[`${field}${SUFFIX}`]
  }
}

function open(o: Record<string, unknown>, field: string, cipher: SecretCipher): void {
  const sealed = o[`${field}${SUFFIX}`]
  delete o[`${field}${SUFFIX}`]
  // A value typed into the file by hand wins over the sealed one.
  if (typeof o[field] === 'string' && o[field]) return
  if (typeof sealed !== 'string' || !sealed) return
  try {
    o[field] = cipher.available() ? cipher.decrypt(sealed) : ''
  } catch {
    // The keychain changed (another user, a reinstalled OS): the value is lost,
    // and the user types it again.
    o[field] = ''
  }
}
