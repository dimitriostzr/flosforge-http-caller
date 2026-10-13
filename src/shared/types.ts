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

export interface ApiRequest {
  kind: 'request'
  id: string
  name: string
  method: HttpMethod
  /** Raw URL as typed, including enabled query params; may contain {{variables}}. */
  url: string
  /** Query params. Enabled ones mirror the query string of `url`. */
  params: KeyValue[]
  headers: KeyValue[]
  body: RequestBody
  auth: Auth
  scripts: Scripts
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
}

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
  askForMissingVariables: true
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
