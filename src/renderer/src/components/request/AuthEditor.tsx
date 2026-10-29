import type { Auth, AuthType } from '@shared/types'
import { VarInput } from '../editor/VarInput'

const TYPES: { id: AuthType; label: string }[] = [
  { id: 'inherit', label: 'Inherit from parent' },
  { id: 'none', label: 'No auth' },
  { id: 'bearer', label: 'Bearer token' },
  { id: 'basic', label: 'Basic auth' },
  { id: 'apikey', label: 'API key' },
  { id: 'oauth2', label: 'OAuth 2.0 (access token)' }
]

interface Props {
  auth: Auth
  onChange: (a: Auth) => void
  /** Collections can't inherit. */
  allowInherit?: boolean
  /** Shown when type is inherit, e.g. "Bearer token from “My API”". */
  inheritedLabel?: string
}

export function AuthEditor({ auth, onChange, allowInherit = true, inheritedLabel }: Props) {
  const types = allowInherit ? TYPES : TYPES.filter((t) => t.id !== 'inherit')
  const set = (patch: Partial<Auth>) => onChange({ ...auth, ...patch })

  return (
    <div className="auth-editor">
      <div className="auth-type">
        <label className="field-label">Type</label>
        <select className="select" value={auth.type} onChange={(e) => set({ type: e.target.value as AuthType })}>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="hint">
          {auth.type === 'inherit' && (inheritedLabel ?? 'Uses the auth configured on the parent folder or collection.')}
          {auth.type === 'none' && 'No Authorization header will be added.'}
          {auth.type === 'bearer' && 'Sends Authorization: Bearer <token>.'}
          {auth.type === 'basic' && 'Sends Authorization: Basic base64(username:password).'}
          {auth.type === 'apikey' && 'Adds the key as a header or query parameter.'}
          {auth.type === 'oauth2' && 'Paste an access token; it is sent as <prefix> <token>.'}
        </p>
      </div>

      <div className="auth-fields">
        {auth.type === 'bearer' && (
          <Field label="Token">
            <VarInput
              value={auth.bearer?.token ?? ''}
              onChange={(token) => set({ bearer: { token } })}
              placeholder="{{token}}"
            />
          </Field>
        )}
        {auth.type === 'basic' && (
          <>
            <Field label="Username">
              <VarInput
                value={auth.basic?.username ?? ''}
                onChange={(username) => set({ basic: { password: auth.basic?.password ?? '', username } })}
              />
            </Field>
            <Field label="Password">
              <VarInput
                value={auth.basic?.password ?? ''}
                onChange={(password) => set({ basic: { username: auth.basic?.username ?? '', password } })}
                masked
              />
            </Field>
          </>
        )}
        {auth.type === 'apikey' && (
          <>
            <Field label="Key">
              <VarInput
                value={auth.apikey?.key ?? ''}
                onChange={(key) => set({ apikey: { value: '', in: 'header', ...auth.apikey, key } })}
                placeholder="X-API-Key"
              />
            </Field>
            <Field label="Value">
              <VarInput
                value={auth.apikey?.value ?? ''}
                onChange={(value) => set({ apikey: { key: '', in: 'header', ...auth.apikey, value } })}
              />
            </Field>
            <Field label="Add to">
              <select
                className="select"
                value={auth.apikey?.in ?? 'header'}
                onChange={(e) =>
                  set({ apikey: { key: '', value: '', ...auth.apikey, in: e.target.value as 'header' | 'query' } })
                }
              >
                <option value="header">Header</option>
                <option value="query">Query params</option>
              </select>
            </Field>
          </>
        )}
        {auth.type === 'oauth2' && (
          <>
            <Field label="Access token">
              <VarInput
                value={auth.oauth2?.accessToken ?? ''}
                onChange={(accessToken) => set({ oauth2: { headerPrefix: 'Bearer', ...auth.oauth2, accessToken } })}
              />
            </Field>
            <Field label="Header prefix">
              <VarInput
                value={auth.oauth2?.headerPrefix ?? 'Bearer'}
                onChange={(headerPrefix) => set({ oauth2: { accessToken: '', ...auth.oauth2, headerPrefix } })}
              />
            </Field>
          </>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      <div className="field-control">{children}</div>
    </div>
  )
}
