// Core data model shared by the main process, preload and renderer.
// Everything here must stay structured-clone friendly (no classes, no functions).

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | (string & {})

export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

export interface KeyValue {
  id: string
  key: string
  value: string
  enabled: boolean
  description?: string
}

export interface Variable extends KeyValue {
  /** Masked in the UI; still sent in requests. */
  secret?: boolean
}

export interface FormField extends KeyValue {
  kind: 'text' | 'file'
  /** Absolute file paths when kind === 'file'. */
  files?: string[]
  contentType?: string
}

export type AuthType = 'inherit' | 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2'

export interface Auth {
  type: AuthType
  bearer?: { token: string }
  basic?: { username: string; password: string }
  apikey?: { key: string; value: string; in: 'header' | 'query' }
  /** Token-only OAuth 2.0: the token is sent as `<headerPrefix> <accessToken>`. */
  oauth2?: { accessToken: string; headerPrefix: string }
}

export type BodyMode = 'none' | 'raw' | 'urlencoded' | 'formdata' | 'binary' | 'graphql'
export type RawLanguage = 'json' | 'text' | 'xml' | 'html' | 'javascript'

export interface RequestBody {
  mode: BodyMode
  raw: string
  rawLanguage: RawLanguage
  urlencoded: KeyValue[]
  formdata: FormField[]
  binaryPath: string
  graphql: { query: string; variables: string }
}

export interface Scripts {
  preRequest: string
  test: string
}

export type CaptureSource = 'body' | 'header' | 'cookie' | 'status'
/** `local`: for the rest of the run (and the request's test scripts), never saved. */
export type CaptureScope = 'environment' | 'collection' | 'globals' | 'local'

/** Takes a value from the response into a variable, without writing a script. */
export interface Capture {
  id: string
  enabled: boolean
  /** The variable to set, without braces. */
  variable: string
  source: CaptureSource
  /** body: a JSON path like `$.data.token` (empty = the whole body); header or cookie: its name. */
  path: string
  /** Optional regular expression run on the value: its first group (or the whole match) is kept. */
  regex: string
  scope: CaptureScope
}

export interface ApiRequest {
  kind: 'request'
  id: string
  name: string
  method: HttpMethod
  /** Raw URL as typed, including enabled query params; may contain {{variables}}. */
  url: string
  /** Query params. Enabled ones mirror the query string of `url`. */
  params: KeyValue[]
  /**
   * Values for `:name` path segments, in URL order. Keys mirror the URL; a
   * segment without a value is sent as typed. Missing in data saved before
   * path variables existed.
   */
  pathVariables?: KeyValue[]
  headers: KeyValue[]
  body: RequestBody
  auth: Auth
  scripts: Scripts
  /** Values to take from the response; run before the test scripts. Missing in older data. */
  captures?: Capture[]
  description: string
}

export interface Folder {
  kind: 'folder'
  id: string
  name: string
  items: TreeItem[]
  auth: Auth
  scripts: Scripts
  description: string
}

export type TreeItem = ApiRequest | Folder

export interface Collection {
  id: string
  name: string
  items: TreeItem[]
  auth: Auth
  scripts: Scripts
  variables: Variable[]
  description: string
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Flows: saved chains of library requests, with conditions and repeats

export type ConditionOp =
  | 'equals'
  | 'not-equals'
  | 'contains'
  | 'not-contains'
  | 'matches'
  | 'exists'
  | 'not-exists'
  | 'greater'
  | 'less'

/** A check on a variable, or on the step's response (status, a body value, a header, a cookie). */
export interface FlowCondition {
  source: 'variable' | CaptureSource
  /** The variable's name, a JSON path, or a header or cookie name. */
  path: string
  op: ConditionOp
  /** What to compare with; {{variables}} allowed. Unused by exists / not-exists. */
  value: string
}

export interface FlowStep {
  id: string
  kind: 'request' | 'delay'
  enabled: boolean
  /** Request steps: the library request they run. It's run as saved, so editing it changes the flow. */
  collectionId?: string
  requestId?: string
  /** Values for this step only, above the environment; {{variables}} allowed. */
  variables?: KeyValue[]
  /** Captures for this step, on top of the request's own. */
  captures?: Capture[]
  /** Run the step only when this holds (checked on variables, before it runs). */
  runIf?: FlowCondition
  /** Send again until this holds, at most `times` sends, `delayMs` apart (polling a job, say). */
  repeatUntil?: { condition: FlowCondition; times: number; delayMs: number }
  /** The step fails unless this holds, on top of failing on errors and failed tests. */
  expect?: FlowCondition
  /** A failed step stops the flow unless this is 'continue'. */
  onFailure?: 'stop' | 'continue'
  /** Delay steps: how long to wait. */
  delayMs?: number
}

export interface Flow {
  id: string
  name: string
  description: string
  steps: FlowStep[]
  createdAt: number
  updatedAt: number
}

export interface Environment {
  id: string
  name: string
  variables: Variable[]
}

/** Light/dark preference. Only applies to themes that don't fix their own scheme. */
export type Appearance = 'system' | 'dark' | 'light'

/**
 * A theme the user made, usually by copying a built-in one and moving a few
 * colours. Colours are #RRGGBB strings so a theme can be read, edited by hand
 * and pasted between machines.
 */
export interface CustomTheme {
  id: string
  name: string
  scheme: 'dark' | 'light'
  monospaced: boolean
  accent: string
  secondary: string
  /** App chrome: rail, tab bar. */
  window: string
  /** Panels and editors. */
  list: string
  /** Inputs, chips, hover fills. */
  surface: string
  stroke: string
  card: string
  /** Tints all text; null keeps the scheme's default ink. */
  foreground: string | null
}

export interface Settings {
  appearance: Appearance
  /** A built-in theme id, or `custom:<id>` for one of `customThemes`. */
  themeId: string
  customThemes: CustomTheme[]
  /** 0 = no timeout */
  timeoutMs: number
  followRedirects: boolean
  maxRedirects: number
  verifySsl: boolean
  useCookieJar: boolean
  /** Response panel placement relative to the request editor. */
  layout: 'stacked' | 'side'
  historyLimit: number
  /** Max milliseconds a single script may run before it is killed. */
  scriptTimeoutMs: number
  /** When sending with undefined {{variables}}, ask for their values first. */
  askForMissingVariables: boolean
  proxy: ProxySettings
  certificates: CertificateSettings
}

/**
 * - off: always connect directly
 * - system: the operating system's proxy settings (in the CLI: HTTP_PROXY,
 *   HTTPS_PROXY, ALL_PROXY and NO_PROXY)
 * - custom: `url` for every request, except hosts in `bypass`
 */
export interface ProxySettings {
  mode: 'off' | 'system' | 'custom'
  /** http://host:port, socks5://host:port or socks5h://host:port */
  url: string
  username: string
  password: string
  /** Comma-separated hosts that skip the proxy: `example.com`, `.example.com`, `*.example.com`, `host:8080`, `*`. */
  bypass: string
}

/** A client certificate (mutual TLS) for the hosts that match `host`. */
export interface ClientCertificate {
  id: string
  enabled: boolean
  /** `api.example.com`, `*.example.com`, optionally with `:port`. */
  host: string
  /** PEM certificate and key, or a PKCS#12 bundle in `pfxPath`. */
  certPath: string
  keyPath: string
  pfxPath: string
  passphrase: string
}

export interface CertificateSettings {
  /** Also trust the certificates installed in the operating system (corporate roots, for example). */
  useSystemCa: boolean
  /** Extra CA certificate files (PEM or DER) trusted on top of the built-in list. */
  caPaths: string[]
  client: ClientCertificate[]
}

export const DEFAULT_PROXY: ProxySettings = {
  mode: 'system',
  url: '',
  username: '',
  password: '',
  bypass: 'localhost, 127.0.0.1, ::1'
}

export const DEFAULT_CERTIFICATES: CertificateSettings = { useSystemCa: false, caPaths: [], client: [] }

export const DEFAULT_SETTINGS: Settings = {
  appearance: 'system',
  themeId: 'flosforge',
  customThemes: [],
  timeoutMs: 30000,
  followRedirects: true,
  maxRedirects: 10,
  verifySsl: true,
  useCookieJar: true,
  layout: 'stacked',
  historyLimit: 200,
  scriptTimeoutMs: 5000,
  askForMissingVariables: true,
  proxy: DEFAULT_PROXY,
  certificates: DEFAULT_CERTIFICATES
}

// ---------------------------------------------------------------------------
// Wire format between renderer and main for executing a request.
// Variables are already resolved and auth already applied at this point.

export type PreparedBody =
  | { type: 'none' }
  | { type: 'text'; text: string }
  | { type: 'multipart'; fields: PreparedFormField[] }
  | { type: 'file'; path: string }

export interface PreparedFormField {
  name: string
  value?: string
  filePath?: string
  contentType?: string
}

export interface PreparedRequest {
  /** Unique per execution; used for cancellation. */
  execId: string
  method: string
  url: string
  headers: [string, string][]
  body: PreparedBody
}

export interface ExecOptions {
  timeoutMs: number
  followRedirects: boolean
  maxRedirects: number
  verifySsl: boolean
  useCookieJar: boolean
  /** Omitted = connect directly. */
  proxy?: ProxySettings
  certificates?: CertificateSettings
}

/**
 * Sent while a response arrives, so the UI can show it before it ends (server-sent
 * events, streamed JSON). `head` once, then `data` as text comes in.
 */
export type ExecProgress =
  | { type: 'head'; status: number; statusText: string; httpVersion: string; headers: [string, string][] }
  | {
      type: 'data'
      /** Text received since the last event; empty for binary bodies or past the live-view limit. */
      text: string
      /** Decoded bytes received so far. */
      bytes: number
    }

export interface Timings {
  /** All values are milliseconds; undefined when the phase did not happen (e.g. reused socket). */
  dns?: number
  connect?: number
  tls?: number
  firstByte: number
  download: number
  total: number
}

export interface HttpResponse {
  status: number
  statusText: string
  httpVersion: string
  /** Header pairs in received order; duplicates (e.g. set-cookie) kept. */
  headers: [string, string][]
  /** Decompressed body. */
  body: Uint8Array
  /** Bytes received on the wire (compressed). */
  bodySize: number
  headersSize: number
  timings: Timings
  /** Final URL after redirects. */
  url: string
  redirects: { url: string; status: number }[]
  remoteAddress?: string
  /** Headers actually sent on the final hop (includes cookies, content-length etc.). */
  requestHeaders: [string, string][]
  /** Set when the body was cut short (the user stopped a stream); the body holds what arrived. */
  incomplete?: string
  /** The proxy the request went through, without credentials. */
  proxy?: string
}

export type ExecResult =
  | { ok: true; response: HttpResponse }
  | { ok: false; error: { message: string; code?: string } }

export interface CookieInfo {
  key: string
  value: string
  domain: string
  path: string
  expires?: string
  httpOnly: boolean
  secure: boolean
  sameSite?: string
}

// ---------------------------------------------------------------------------
// Persistence

export interface HistoryEntry {
  id: string
  at: number
  request: ApiRequest
  /** Fully resolved URL that was sent. */
  resolvedUrl: string
  status?: number
  timeMs?: number
  error?: string
}

/**
 * A separate space for unrelated work: its own collections, environments,
 * globals, history and open tabs. Settings and the cookie jar are app-wide.
 */
export interface Workspace {
  id: string
  name: string
  /** The workspace's accent. Null uses the active theme's accent. */
  color: string | null
  createdAt: number
  /** Also shown as a badge in the sidebar rail (above Library), for one-click switching. */
  inSidebar?: boolean
}

export interface WorkspaceIndex {
  workspaces: Workspace[]
  activeId: string
}

/** UI state restored on launch. */
export interface SessionState {
  activeEnvironmentId: string | null
  tabs?: unknown[]
  activeTabId?: string | null
  sidebarWidth?: number
  splitRatio?: number
  /** Expanded collections/folders in the sidebar tree. */
  expanded?: Record<string, boolean>
}

/** Everything stored inside one workspace. */
export interface WorkspaceData {
  collections: Collection[]
  environments: Environment[]
  globals: Variable[]
  session: SessionState
  history: HistoryEntry[]
  flows: Flow[]
}

/** What the renderer needs at launch. */
export interface BootData {
  index: WorkspaceIndex
  settings: Settings
  data: WorkspaceData
}

export interface OpenedFile {
  name: string
  path: string
  content: string
}
