// Painted themes, ported from FlosForge Reader so the apps share one palette.
// Labels describe the colours rather than cite other products' names.
// Ids are storage keys: renaming one resets that user's theme, so change `label` instead.
// Generated once from the reader's AppTheme.swift; edit freely from here on.

export interface ThemeDef {
  id: string
  label: string
  summary: string
  /** Null follows the Appearance setting (system/light/dark). */
  scheme: 'dark' | 'light' | null
  /** Unset on the built-in themes, which use the hand-tuned tokens in styles.css. */
  accent?: string
  secondary?: string
  window?: string
  list?: string
  surface?: string
  stroke?: string
  card?: string
  selection?: string
  /** Tints all text. Only the terminal themes set it. */
  foreground?: string
  monospaced?: boolean
}

export const BUILTIN_THEMES: ThemeDef[] = [
  {
    id: 'flosforge',
    label: 'FlosForge',
    summary: 'The house look: teal accent, follows the light or dark setting.',
    scheme: null
  },
  {
    id: 'system',
    label: 'System',
    summary: 'Your operating system\'s accent colour, and the light or dark setting.',
    scheme: null
  }
]

export const PAINTED_THEMES: ThemeDef[] = [
  { id: 'cyberpunk', label: "Cyberpunk", summary: "Magenta and cyan on near-black.", scheme: 'dark', accent: '#FF2E97', secondary: '#00E5FF', window: '#0B0714', list: '#0F0A1C', surface: '#1B1030', stroke: '#3B2A5C', card: '#191033', selection: '#FF2E9738' },
  { id: 'hothouse', label: "Hothouse", summary: "Warm charcoal under pink and green. An editor palette that stayed up late.", scheme: 'dark', accent: '#F92672', secondary: '#66D9EF', window: '#272822', list: '#2C2D27', surface: '#32332B', stroke: '#49483E', card: '#3A3B33', selection: '#F9267238' },
  { id: 'phosphor', label: "Phosphor", summary: "Phosphor green on black, set entirely in a fixed-width face.", scheme: 'dark', accent: '#00FF6A', secondary: '#7CFFB2', window: '#000000', list: '#050A06', surface: '#0B140D', stroke: '#12401F', card: '#0A1A0E', selection: '#00FF6A2E', foreground: '#3BFF8D', monospaced: true },
  { id: 'fjord', label: "Fjord", summary: "Cool, low-contrast blues. Easier on the eyes for a long session.", scheme: 'dark', accent: '#88C0D0', secondary: '#A3BE8C', window: '#2E3440', list: '#333B4C', surface: '#3B4252', stroke: '#4C566A', card: '#3B4252', selection: '#88C0D03D' },
  { id: 'vesper', label: "Vesper", summary: "Purple-grey with a violet accent.", scheme: 'dark', accent: '#BD93F9', secondary: '#8BE9FD', window: '#282A36', list: '#2E3040', surface: '#343746', stroke: '#44475A', card: '#343746', selection: '#BD93F93D' },
  { id: 'meridian', label: "Meridian", summary: "The classic low-glare pairing: blue-grey base, restrained accents.", scheme: 'dark', accent: '#268BD2', secondary: '#2AA198', window: '#002B36', list: '#01323D', surface: '#073642', stroke: '#0E4B59', card: '#073642', selection: '#268BD242' },
  { id: 'bracken', label: "Bracken", summary: "Retro warmth \u2014 muddy browns with orange and aqua.", scheme: 'dark', accent: '#FE8019', secondary: '#8EC07C', window: '#282828', list: '#2E2B28', surface: '#3C3836', stroke: '#504945', card: '#3C3836', selection: '#FE801938' },
  { id: 'indigo-night', label: "Indigo Night", summary: "Deep indigo with a soft blue accent.", scheme: 'dark', accent: '#7AA2F7', secondary: '#BB9AF7', window: '#1A1B26', list: '#1F2030', surface: '#24283B', stroke: '#3B4261', card: '#24283B', selection: '#7AA2F73D' },
  { id: 'slate', label: "Slate", summary: "Slate grey with a clear blue. The editor default, made calm.", scheme: 'dark', accent: '#61AFEF', secondary: '#98C379', window: '#282C34', list: '#2C313A', surface: '#333842', stroke: '#454C59', card: '#333842', selection: '#61AFEF3D' },
  { id: 'paper', label: "Paper", summary: "Warm off-white with ink blue. The only light theme other than Standard.", scheme: 'light', accent: '#3B6EA5', secondary: '#7A6A53', window: '#FAF7F0', list: '#F4F0E6', surface: '#EAE4D6', stroke: '#D8CFBB', card: '#FFFDF7', selection: '#3B6EA52E' },
  { id: 'praline', label: "Praline", summary: "Soft pastels on deep violet-grey. Gentle contrast.", scheme: 'dark', accent: '#CBA6F7', secondary: '#94E2D5', window: '#1E1E2E', list: '#232338', surface: '#313244', stroke: '#45475A', card: '#313244', selection: '#CBA6F73D' },
  { id: 'praline-light', label: "Praline Light", summary: "The same pastels, inverted \u2014 a soft light palette.", scheme: 'light', accent: '#8839EF', secondary: '#179299', window: '#EFF1F5', list: '#E6E9EF', surface: '#DCE0E8', stroke: '#BCC0CC', card: '#FFFFFF', selection: '#8839EF29' },
  { id: 'rosewood', label: "Rosewood", summary: "Muted rose and pine on near-black plum.", scheme: 'dark', accent: '#EBBCBA', secondary: '#9CCFD8', window: '#191724', list: '#1F1D2E', surface: '#26233A', stroke: '#403D52', card: '#26233A', selection: '#EBBCBA38' },
  { id: 'everglade', label: "Everglade", summary: "Forest greens on warm grey. Low glare.", scheme: 'dark', accent: '#A7C080', secondary: '#7FBBB3', window: '#2D353B', list: '#323D43', surface: '#3D484D', stroke: '#4F585E', card: '#3D484D', selection: '#A7C0803D' },
  { id: 'ember-dark', label: "Ember Dark", summary: "Near-black with a single warm amber accent.", scheme: 'dark', accent: '#FFB454', secondary: '#59C2FF', window: '#0B0E14', list: '#0F131A', surface: '#151A23', stroke: '#2A313C', card: '#151A23', selection: '#FFB45433' },
  { id: 'ember-light', label: "Ember Light", summary: "Bright and clean, with the same amber accent.", scheme: 'light', accent: '#FF9940', secondary: '#399EE6', window: '#FCFCFC', list: '#F3F4F5', surface: '#E7E8E9', stroke: '#D2D4D6', card: '#FFFFFF', selection: '#FF994033' },
  { id: 'repo-dark', label: "Repo Dark", summary: "The familiar dark of a code review at midnight.", scheme: 'dark', accent: '#58A6FF', secondary: '#3FB950', window: '#0D1117', list: '#10151C', surface: '#161B22', stroke: '#30363D', card: '#161B22', selection: '#58A6FF38' },
  { id: 'repo-light', label: "Repo Light", summary: "Plain white with a clear code-review blue.", scheme: 'light', accent: '#0969DA', secondary: '#1A7F37', window: '#FFFFFF', list: '#F6F8FA', surface: '#EAEEF2', stroke: '#D0D7DE', card: '#FFFFFF', selection: '#0969DA24' },
  { id: 'retrowave', label: "Retrowave", summary: "Hot pink on deep indigo. Louder than Cyberpunk, and means to be.", scheme: 'dark', accent: '#FF7EDB', secondary: '#36F9F6', window: '#262335', list: '#2A2640', surface: '#34294F', stroke: '#495495', card: '#34294F', selection: '#FF7EDB3D' },
  { id: 'amber-terminal', label: "Amber Terminal", summary: "Amber phosphor on black, fixed-width throughout. Phosphor's warmer sibling.", scheme: 'dark', accent: '#FFB000', secondary: '#FFD37A', window: '#0A0700', list: '#100B00', surface: '#1A1200', stroke: '#4A3300', card: '#151000', selection: '#FFB00033', monospaced: true },
  { id: 'high-contrast', label: "High Contrast", summary: "Pure black and white with a bright accent, for maximum legibility.", scheme: 'dark', accent: '#FFD60A', secondary: '#0A84FF', window: '#000000', list: '#000000', surface: '#1C1C1E', stroke: '#8E8E93', card: '#1C1C1E', selection: '#FFD60A47' },
  { id: 'ink-wash', label: "Ink Wash", summary: "Ink-wash blues and muted gold, after a woodblock sea.", scheme: 'dark', accent: '#7E9CD8', secondary: '#98BB6C', window: '#1F1F28', list: '#24242F', surface: '#2A2A37', stroke: '#3D3D4E', card: '#2A2A37', selection: '#7E9CD83D' },
  { id: 'olivewood', label: "Olivewood", summary: "Low-contrast olive and peach. Designed to be looked at for hours.", scheme: 'dark', accent: '#DFAF8F', secondary: '#8CD0D3', window: '#3F3F3F', list: '#464646', surface: '#4F4F4F', stroke: '#5F5F5F', card: '#4F4F4F', selection: '#DFAF8F38' },
  { id: 'cobalt', label: "Cobalt", summary: "Deep sea blue with a hard yellow accent.", scheme: 'dark', accent: '#FFC600', secondary: '#3AD900', window: '#193549', list: '#1C3C54', surface: '#204863', stroke: '#2E5C7A', card: '#204863', selection: '#FFC60033' },
  { id: 'small-hours', label: "Small Hours", summary: "Midnight navy, tuned for reading in the dark.", scheme: 'dark', accent: '#82AAFF', secondary: '#7FDBCA', window: '#011627', list: '#01202F', surface: '#0B2739', stroke: '#1D3B53', card: '#0B2739', selection: '#82AAFF3D' },
  { id: 'hoarfrost', label: "Hoarfrost", summary: "Slate blue with a mint accent. Quiet and cold.", scheme: 'dark', accent: '#5DE4C7', secondary: '#ADD7FF', window: '#1B1E28', list: '#202430', surface: '#252B37', stroke: '#3A4152', card: '#252B37', selection: '#5DE4C733' },
  { id: 'deep-ocean', label: "Deep Ocean", summary: "Almost-black blue under a full spread of colour.", scheme: 'dark', accent: '#82AAFF', secondary: '#C3E88D', window: '#0F111A', list: '#141828', surface: '#1A1F2E', stroke: '#2E3548', card: '#1A1F2E', selection: '#82AAFF38' },
  { id: 'dusklight', label: "Dusklight", summary: "Dusky indigo with lilac. Softer than Deep Ocean.", scheme: 'dark', accent: '#C792EA', secondary: '#89DDFF', window: '#292D3E', list: '#2F3447', surface: '#353B52', stroke: '#454B66', card: '#353B52', selection: '#C792EA3D' },
  { id: 'tidewater', label: "Tidewater", summary: "Teal-grey, low saturation, easy on a bright room.", scheme: 'dark', accent: '#6699CC', secondary: '#5FB3B3', window: '#1B2B34', list: '#20333D', surface: '#253B46', stroke: '#37505C', card: '#253B46', selection: '#6699CC3D' },
  { id: 'horizon', label: "Horizon", summary: "Warm coral on charcoal. Sunset colours.", scheme: 'dark', accent: '#E95678', secondary: '#29D398', window: '#1C1E26', list: '#21242E', surface: '#282C36', stroke: '#3D4351', card: '#282C36', selection: '#E9567838' },
  { id: 'meridian-light', label: "Meridian Light", summary: "The light half of Meridian: warm cream, restrained accents.", scheme: 'light', accent: '#268BD2', secondary: '#2AA198', window: '#FDF6E3', list: '#F5EEDB', surface: '#EEE8D5', stroke: '#DDD6C1', card: '#FFFBF0', selection: '#268BD229' },
  { id: 'bracken-light', label: "Bracken Light", summary: "The retro warmth, inverted \u2014 cream with burnt orange.", scheme: 'light', accent: '#AF3A03', secondary: '#427B58', window: '#FBF1C7', list: '#F4E8BE', surface: '#EBDBB2', stroke: '#D5C4A1', card: '#FFFBEF', selection: '#AF3A0329' },
  { id: 'fjord-light', label: "Fjord Light", summary: "The pale end of Fjord: cool greys with the same blue.", scheme: 'light', accent: '#5E81AC', secondary: '#8FBCBB', window: '#ECEFF4', list: '#E5E9F0', surface: '#DCE1EA', stroke: '#C7CEDA', card: '#FFFFFF', selection: '#5E81AC29' },
  { id: 'rosewood-dawn', label: "Rosewood Dawn", summary: "Rosewood in daylight: blush and stone.", scheme: 'light', accent: '#B4637A', secondary: '#286983', window: '#FAF4ED', list: '#F2E9E1', surface: '#EDE5DD', stroke: '#DFD5CC', card: '#FFFAF3', selection: '#B4637A29' },
  { id: 'nightfall', label: "Nightfall", summary: "The classic balanced dark \u2014 nothing shouts.", scheme: 'dark', accent: '#81A2BE', secondary: '#B5BD68', window: '#1D1F21', list: '#232527', surface: '#282A2E', stroke: '#3E4145', card: '#282A2E', selection: '#81A2BE3D' },
  { id: 'iceberg', label: "Iceberg", summary: "Blue-grey and cold, like light through ice.", scheme: 'dark', accent: '#84A0C6', secondary: '#89B8C2', window: '#161821', list: '#1C1E29', surface: '#22242F', stroke: '#3A3F52', card: '#22242F', selection: '#84A0C63D' },
  { id: 'bluejay', label: "Bluejay", summary: "Deep navy with a clear blue. Crisp edges.", scheme: 'dark', accent: '#719CD6', secondary: '#81B29A', window: '#192330', list: '#1D2A3A', surface: '#212E3F', stroke: '#39506D', card: '#212E3F', selection: '#719CD63D' },
  { id: 'sparse', label: "Sparse", summary: "Near-black with a single muted green. Very little colour.", scheme: 'dark', accent: '#4D9375', secondary: '#6394BF', window: '#121212', list: '#181818', surface: '#1E1E1E', stroke: '#333333', card: '#1E1E1E', selection: '#4D93753D' },
  { id: 'sparse-light', label: "Sparse Light", summary: "Plain white, one green accent, almost no chrome.", scheme: 'light', accent: '#1E754F', secondary: '#296AA3', window: '#FFFFFF', list: '#F7F7F7', surface: '#EFEFEF', stroke: '#DDDDDD', card: '#FFFFFF', selection: '#1E754F24' },
  { id: 'rouge', label: "Rouge", summary: "Steel blue with a dusty red. Understated warmth.", scheme: 'dark', accent: '#E86A73', secondary: '#8DC3D0', window: '#172030', list: '#1C2739', surface: '#232F42', stroke: '#3A4759', card: '#232F42', selection: '#E86A7338' },
  { id: 'aurora', label: "Aurora", summary: "Northern-light green over deep polar blue.", scheme: 'dark', accent: '#7DF9AA', secondary: '#8FD3FF', window: '#0B0F1A', list: '#101726', surface: '#161F33', stroke: '#25334D', card: '#161F33', selection: '#7DF9AA2E' },
  { id: 'deep-space', label: "Deep Space", summary: "Almost black, with one cold blue. Minimal light.", scheme: 'dark', accent: '#4C8DFF', secondary: '#9E7BFF', window: '#05070F', list: '#080B16', surface: '#0D1220', stroke: '#1E2740', card: '#0D1220', selection: '#4C8DFF38' },
  { id: 'coffee', label: "Coffee", summary: "Roasted browns with cream. Warm all the way down.", scheme: 'dark', accent: '#C88F5E', secondary: '#A3B18A', window: '#231A16', list: '#2A201B', surface: '#33261F', stroke: '#4A382E', card: '#33261F', selection: '#C88F5E38' },
  { id: 'moss', label: "Moss", summary: "Damp forest floor: dark green with pale lichen.", scheme: 'dark', accent: '#6FCF97', secondary: '#B9C77E', window: '#12211A', list: '#16281F', surface: '#1C3227', stroke: '#2E4A39', card: '#1C3227', selection: '#6FCF9733' },
  { id: 'desert', label: "Desert", summary: "Sand and terracotta. A light theme that is not white.", scheme: 'light', accent: '#C1663A', secondary: '#6E8B6E', window: '#F5EBDD', list: '#EFE3D2', surface: '#E6D8C3', stroke: '#D2C0A6', card: '#FCF6EC', selection: '#C1663A29' },
  { id: 'sakura', label: "Sakura", summary: "Blossom pink on warm white. Soft and light.", scheme: 'light', accent: '#D96A8F', secondary: '#7A9E9F', window: '#FFF5F7', list: '#FBEBEF', surface: '#F5DEE5', stroke: '#E6C6D0', card: '#FFFBFC', selection: '#D96A8F29' },
  { id: 'vaporwave', label: "Vaporwave", summary: "Pastel violet and mint, on light. Loud but not dark.", scheme: 'light', accent: '#A566FF', secondary: '#00C2B2', window: '#F7E8FF', list: '#F1DDFB', surface: '#E7CFF6', stroke: '#D3B4E8', card: '#FDF7FF', selection: '#A566FF2E' },
  { id: 'newsprint', label: "Newsprint", summary: "Greyscale on paper white. No colour but severity.", scheme: 'light', accent: '#333333', secondary: '#666666', window: '#FFFFFF', list: '#F4F4F4', surface: '#EAEAEA', stroke: '#CCCCCC', card: '#FFFFFF', selection: '#33333324' },
  { id: 'monochrome', label: "Monochrome", summary: "Greyscale on black. No colour but severity.", scheme: 'dark', accent: '#D6D6D6', secondary: '#9A9A9A', window: '#0C0C0C', list: '#131313', surface: '#1B1B1B', stroke: '#3A3A3A', card: '#1B1B1B', selection: '#D6D6D62E' },
  { id: 'blue-dragon', label: "Blue Dragon", summary: "Graphite under a hard dragon blue. Fixed-width.", scheme: 'dark', accent: '#367BF0', secondary: '#00B4D8', window: '#0D1017', list: '#12161F', surface: '#1A1F2B', stroke: '#2A3345', card: '#1A1F2B', selection: '#367BF03D', monospaced: true },
  { id: 'redline', label: "Redline", summary: "Blood red on pure black. Fixed-width, and not subtle.", scheme: 'dark', accent: '#FF2B2B', secondary: '#B0B0B0', window: '#000000', list: '#070707', surface: '#120C0C', stroke: '#3A1414', card: '#0F0A0A', selection: '#FF2B2B33', foreground: '#FF5C5C', monospaced: true },
  { id: 'lightgrid', label: "Lightgrid", summary: "Cyan light on a black grid.", scheme: 'dark', accent: '#00E0FF', secondary: '#FF9E00', window: '#03080D', list: '#061119', surface: '#0A1A24', stroke: '#12455A', card: '#0A1A24', selection: '#00E0FF2E', foreground: '#9FE8F5', monospaced: true },
  { id: 'eight-bit', label: "Eight-Bit", summary: "Blue on blue with lavender text, as a home computer booted in 1982. Fixed-width.", scheme: 'dark', accent: '#7B68EE', secondary: '#A9A0F0', window: '#40318D', list: '#4A3A9E', surface: '#54459E', stroke: '#7869C4', card: '#54459E', selection: '#7869C473', foreground: '#BFB4F5', monospaced: true },
  { id: 'commander', label: "Commander", summary: "DOS blue with cyan and yellow. Two panes and a row of function keys.", scheme: 'dark', accent: '#FFFF55', secondary: '#55FFFF', window: '#0000AA', list: '#000090', surface: '#0000C4', stroke: '#5555FF', card: '#0000C4', selection: '#00AAAA8C', monospaced: true },
  { id: 'modem', label: "Modem", summary: "Magenta and teal on black. Dial-up era, and not embarrassed about it.", scheme: 'dark', accent: '#FF35B8', secondary: '#22F5D3', window: '#05040A', list: '#0A0812', surface: '#120E1F', stroke: '#35204F', card: '#120E1F', selection: '#FF35B833', monospaced: true },
  { id: 'root', label: "Root", summary: "A red prompt on black \u2014 the shell you should be careful in. Fixed-width.", scheme: 'dark', accent: '#E5484D', secondary: '#7EE787', window: '#0A0A0A', list: '#101010', surface: '#171717', stroke: '#2E2E2E', card: '#171717', selection: '#E5484D33', monospaced: true },
  { id: 'teletype', label: "Teletype", summary: "White phosphor on black. A glass teletype, nothing more.", scheme: 'dark', accent: '#E8E8E8', secondary: '#9FD1FF', window: '#000000', list: '#060606', surface: '#101010', stroke: '#2E2E2E', card: '#0C0C0C', selection: '#E8E8E829', foreground: '#D8D8D8', monospaced: true },
  { id: 'freighter', label: "Freighter", summary: "A ship's computer: pale green on black, with amber warnings.", scheme: 'dark', accent: '#9DFFB0', secondary: '#FFB454', window: '#020604', list: '#060D08', surface: '#0C160F', stroke: '#1E3A25', card: '#0A1209', selection: '#9DFFB029', foreground: '#B6F5C4', monospaced: true },
  { id: 'silo', label: "Silo", summary: "Cold cyan-white on midnight blue. A room where somebody is always awake.", scheme: 'dark', accent: '#7FE9FF', secondary: '#FF5F5F', window: '#000813', list: '#01101E', surface: '#041A2B', stroke: '#0E3D5C', card: '#03141F', selection: '#7FE9FF2E', foreground: '#B9EEFF', monospaced: true },
  { id: 'phreak', label: "Phreak", summary: "Blue box: deep navy with a 2600-hertz sky blue.", scheme: 'dark', accent: '#5AC8FA', secondary: '#C0E8FF', window: '#04101F', list: '#07182C', surface: '#0B2138', stroke: '#164866', card: '#0A1B2D', selection: '#5AC8FA33', foreground: '#BFE4F7', monospaced: true },
  { id: 'onion', label: "Onion", summary: "Layered purple on near-black. Routed the long way round.", scheme: 'dark', accent: '#9B59D0', secondary: '#59D0B8', window: '#0A060F', list: '#100A18', surface: '#1A1026', stroke: '#3A2255', card: '#150D20', selection: '#9B59D038', foreground: '#D9C7EC', monospaced: true },
  { id: 'cicada', label: "Cicada", summary: "Gold on black. A puzzle that never explained itself.", scheme: 'dark', accent: '#C9A227', secondary: '#8C7A3F', window: '#050505', list: '#0A0A08', surface: '#14120A', stroke: '#3D3418', card: '#100E08', selection: '#C9A22733', foreground: '#E0C86A', monospaced: true },
  { id: 'sodium', label: "Sodium", summary: "Steel teal under a sodium-orange sky. The city, from a long way up.", scheme: 'dark', accent: '#FF8C42', secondary: '#4FD1C5', window: '#0A1214', list: '#0F1B1E', surface: '#152528', stroke: '#2A4448', card: '#121F22', selection: '#FF8C422E', foreground: '#CFE3E4', monospaced: true },
  { id: 'segfault', label: "Segfault", summary: "Charcoal with a core-dump orange. Something went wrong.", scheme: 'dark', accent: '#FF6B35', secondary: '#F7C59F', window: '#121212', list: '#181614', surface: '#221E1B', stroke: '#463B33', card: '#1D1917', selection: '#FF6B3533', foreground: '#EAD9CE', monospaced: true }
]
