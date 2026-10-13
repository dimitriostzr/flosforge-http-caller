import { emptyBody, formField, kv, newCollection, newEnvironment, newFolder, newRequest, variable } from './model'
import { paramsFromUrl } from './url'
import type { ApiRequest, Auth, Collection, Environment, Folder, RequestBody } from './types'

// A ready-made workspace for trying the app out, built only on free public APIs
// that need no key. Every request has notes (the Notes tab) saying what it
// shows, and tests so the Tests tab has something to report.

export const DEMO_WORKSPACE_NAME = 'Public API Demo'
export const DEMO_WORKSPACE_COLOR = '#9B6BE8'

interface ReqOptions {
  notes?: string
  headers?: [string, string][]
  body?: Partial<RequestBody>
  auth?: Auth
  pre?: string
  test?: string
}

function req(name: string, method: string, url: string, o: ReqOptions = {}): ApiRequest {
  return newRequest({
    name,
    method,
    url,
    params: paramsFromUrl(url, []),
    headers: (o.headers ?? []).map(([k, v]) => kv(k, v)),
    body: { ...emptyBody(), ...o.body },
    auth: o.auth ?? { type: 'inherit' },
    scripts: { preRequest: o.pre ?? '', test: o.test ?? '' },
    description: o.notes ?? ''
  })
}

const json = (value: unknown): Partial<RequestBody> => ({
  mode: 'raw',
  rawLanguage: 'json',
  raw: JSON.stringify(value, null, 2)
})

const folder = (name: string, description: string, items: ApiRequest[], auth?: Auth): Folder =>
  newFolder({ name, description, items, ...(auth ? { auth } : {}) })

export function buildDemo(): { collection: Collection; environment: Environment } {
  const crud = folder(
    '1 · CRUD basics',
    'JSONPlaceholder is a fake REST API: writes are accepted and echoed back, but nothing is stored.',
    [
      req('List posts', 'GET', '{{jsonApi}}/posts?_limit=5', {
        notes: 'Query params live in the Params tab and stay in sync with the URL. Try changing _limit.',
        test: `pm.test('Status is 200', () => pm.response.to.have.status(200))
pm.test('Returns 5 posts', () => pm.expect(pm.response.json()).to.have.lengthOf(5))`
      }),
      req('Get one post', 'GET', '{{jsonApi}}/posts/{{postId}}', {
        notes: 'postId comes from the "Demo" environment (or a runner data file). Hover {{postId}} in the URL to see its value.',
        test: `const post = pm.response.json()
pm.test('Got the post we asked for', () => pm.expect(String(post.id)).to.eql(pm.variables.get('postId')))
pm.environment.set('lastPostTitle', post.title)
console.log('Saved lastPostTitle =', post.title)`
      }),
      req('Create a post', 'POST', '{{jsonApi}}/posts', {
        notes: 'A raw JSON body. {{$isoTimestamp}} is a dynamic variable, generated fresh on every send.',
        body: json({ title: 'Hello from FlosForge Caller', body: 'Sent at {{$isoTimestamp}}', userId: 1 }),
        test: `pm.test('Created', () => pm.response.to.have.status(201))
pm.test('Echoes our title', () => pm.expect(pm.response.json().title).to.eql('Hello from FlosForge Caller'))`
      }),
      req('Replace a post', 'PUT', '{{jsonApi}}/posts/1', {
        body: json({ id: 1, title: 'Replaced title', body: 'Replaced body', userId: 1 }),
        test: `pm.test('Status is 200', () => pm.response.to.have.status(200))`
      }),
      req('Update one field', 'PATCH', '{{jsonApi}}/posts/1', {
        body: json({ title: 'Only the title changes' }),
        test: `pm.test('Title updated', () => pm.response.to.have.jsonBody('title', 'Only the title changes'))`
      }),
      req('Delete a post', 'DELETE', '{{jsonApi}}/posts/1', {
        test: `pm.test('Deleted', () => pm.response.to.be.ok)`
      }),
      (() => {
        const r = req('Comments on a post', 'GET', '{{jsonApi}}/comments?postId={{postId}}', {
          notes: 'The Params tab has a second, disabled parameter. Tick it to limit the results.',
          test: `pm.test('Every comment belongs to the post', () => {
  for (const c of pm.response.json()) pm.expect(String(c.postId)).to.eql(pm.variables.get('postId'))
})`
        })
        r.params.push({ ...kv('_limit', '2'), enabled: false })
        return r
      })()
    ]
  )

  const auth = folder(
    '2 · Auth',
    'This folder sets Bearer auth with {{demoToken}}. Requests set to "Inherit" use it; others override it.',
    [
      req('Bearer token (inherited)', 'GET', '{{httpbin}}/bearer', {
        notes: 'Auth tab → "Inherit from parent". The token comes from this folder’s settings (double-click the folder).',
        test: `pm.test('Authenticated with our token', () => pm.expect(pm.response.json().token).to.eql(pm.environment.get('demoToken')))`
      }),
      req('Basic auth', 'GET', '{{httpbin}}/basic-auth/demo/secret', {
        auth: { type: 'basic', basic: { username: 'demo', password: 'secret' } },
        test: `pm.test('Logged in as demo', () => pm.response.to.have.jsonBody('user', 'demo'))`
      }),
      req('API key in a header', 'GET', '{{httpbin}}/headers', {
        auth: { type: 'apikey', apikey: { key: 'X-Api-Key', value: '{{demoApiKey}}', in: 'header' } },
        test: `pm.test('Key was sent', () => pm.expect(pm.response.json().headers['X-Api-Key']).to.eql(pm.environment.get('demoApiKey')))`
      }),
      req('API key in the query string', 'GET', '{{httpbin}}/get', {
        auth: { type: 'apikey', apikey: { key: 'api_key', value: '{{demoApiKey}}', in: 'query' } },
        test: `pm.test('Key was sent', () => pm.expect(pm.response.json().args.api_key).to.eql(pm.environment.get('demoApiKey')))`
      }),
      req('No auth (expect 401)', 'GET', '{{httpbin}}/bearer', {
        auth: { type: 'none' },
        notes: 'Overrides the folder with "No auth", so the server refuses it.',
        test: `pm.test('Unauthorized without a token', () => pm.response.to.have.status(401))`
      })
    ],
    { type: 'bearer', bearer: { token: '{{demoToken}}' } }
  )

  const bodies = folder('3 · Request bodies', 'httpbin.org/anything echoes back exactly what it received.', [
    req('JSON', 'POST', '{{httpbin}}/anything', {
      body: json({ city: 'Athens', tags: ['api', 'demo'], nested: { ok: true } }),
      test: `pm.test('Server parsed our JSON', () => pm.expect(pm.response.json().json.city).to.eql('Athens'))`
    }),
    req('URL-encoded form', 'POST', '{{httpbin}}/anything', {
      body: { mode: 'urlencoded', urlencoded: [kv('name', 'Ada Lovelace'), kv('lang', 'en & el')] },
      test: `pm.test('Form fields arrived', () => pm.expect(pm.response.json().form.lang).to.eql('en & el'))`
    }),
    req('Multipart form', 'POST', '{{httpbin}}/anything', {
      notes: 'Switch a field’s type to File to upload something from disk.',
      body: { mode: 'formdata', formdata: [formField('title', 'Quarterly report'), formField('draft', 'true')] },
      test: `pm.test('Multipart fields arrived', () => pm.expect(pm.response.json().form.title).to.eql('Quarterly report'))`
    }),
    req('XML', 'POST', '{{httpbin}}/anything', {
      body: { mode: 'raw', rawLanguage: 'xml', raw: '<note>\n  <to>World</to>\n  <body>Hello</body>\n</note>' },
      test: `pm.test('Sent as XML', () => pm.expect(pm.response.json().headers['Content-Type']).to.include('xml'))`
    }),
    req('GraphQL', 'POST', 'https://countries.trevorblades.com/', {
      notes: 'Body → GraphQL: the query on the left, variables on the right.',
      body: {
        mode: 'graphql',
        graphql: {
          query: 'query Country($code: ID!) {\n  country(code: $code) {\n    name\n    capital\n    emoji\n    currency\n  }\n}',
          variables: '{\n  "code": "{{countryCode}}"\n}'
        }
      },
      test: `const c = pm.response.json().data.country
pm.test('Found the country', () => pm.expect(c.name).to.be.a('string'))
console.log(c.emoji, c.name, '— capital', c.capital)`
    })
  ])

  const responses = folder('4 · Responses & previews', 'Different kinds of responses and how the response panel shows them.', [
    req('Image (Preview)', 'GET', '{{httpbin}}/image/png', {
      notes: 'The body opens in Preview. The download button saves it to disk.'
    }),
    req('HTML page (Preview)', 'GET', '{{httpbin}}/html', {
      notes: 'Pretty shows the source; Preview renders it in a sandbox with scripts disabled.'
    }),
    req('XML response', 'GET', '{{httpbin}}/xml'),
    req('Gzip-compressed', 'GET', '{{httpbin}}/gzip', {
      notes: 'Decompressed automatically. Compare Size (on the wire) with the body you see.',
      test: `pm.test('Was gzipped', () => pm.expect(pm.response.json().gzipped).to.eql(true))`
    }),
    req('Follows redirects', 'GET', '{{httpbin}}/redirect/3', {
      notes: 'Three hops. The Timeline tab lists each redirect.',
      test: `pm.test('Ended up at /get', () => pm.expect(pm.response.json().url).to.include('/get'))`
    }),
    req("I'm a teapot (418)", 'GET', '{{httpbin}}/status/418', {
      test: `pm.test('Teapot', () => pm.response.to.have.status(418))`
    }),
    req('Slow response (3 s)', 'GET', '{{httpbin}}/delay/3', {
      notes: 'Press Cancel while it waits. Hover the Time in the status bar for the timing breakdown.'
    }),
    req('Set a cookie', 'GET', '{{httpbin}}/cookies/set?flavor=chocolate', {
      notes: 'The server sets a cookie and redirects. Then run "Read cookies back", or open the cookie jar from the rail.'
    }),
    req('Read cookies back', 'GET', '{{httpbin}}/cookies', {
      test: `pm.test('Cookie jar sent our cookie', () => pm.expect(pm.response.json().cookies.flavor).to.eql('chocolate'))`
    })
  ])

  const scripts = folder('5 · Scripts & chaining', 'Pre-request scripts run before sending; test scripts after the response arrives.', [
    req('Random post (pre-request)', 'GET', '{{jsonApi}}/posts/{{randomId}}', {
      notes: 'The pre-request script picks a random id into a request-scoped variable.',
      pre: `pm.variables.set('randomId', String(Math.floor(Math.random() * 100) + 1))
console.log('Picked post', pm.variables.get('randomId'))`,
      test: `pm.test('Got the random post', () => pm.expect(String(pm.response.json().id)).to.eql(pm.variables.get('randomId')))`
    }),
    req('Fetch something first', 'GET', '{{httpbin}}/headers', {
      notes: 'pm.sendRequest fetches a UUID first, which is then added as a header.',
      pre: `const res = await pm.sendRequest(pm.variables.replaceIn('{{httpbin}}/uuid'))
const id = res.json().uuid
// (httpbin drops X-Request-Id, so the demo uses its own header name.)
pm.request.headers.upsert({ key: 'X-Demo-Trace', value: id })
pm.variables.set('requestId', id)`,
      test: `pm.test('Header from the first call was sent', () =>
  pm.expect(pm.response.json().headers['X-Demo-Trace']).to.eql(pm.variables.get('requestId')))`
    }),
    req('Save a value…', 'GET', '{{jsonApi}}/users/1', {
      notes: 'Saves the user’s email into the environment. Open Envs → Demo to see it appear.',
      test: `const user = pm.response.json()
pm.environment.set('userEmail', user.email)
pm.test('Saved the email', () => pm.expect(pm.environment.get('userEmail')).to.include('@'))`
    }),
    req('…and use it', 'GET', '{{jsonApi}}/users?email={{userEmail}}', {
      notes: 'Run "Save a value…" first. Until then, {{userEmail}} shows red because it is undefined.',
      test: `pm.test('Found the same user', () => pm.expect(pm.response.json()[0]?.id).to.eql(1))`
    }),
    req('Signed request (HMAC)', 'POST', '{{httpbin}}/anything', {
      notes: 'Signs the body with CryptoJS, like many webhook and payment APIs require.',
      body: json({ amount: 42, currency: 'EUR' }),
      pre: `const signature = CryptoJS.HmacSHA256(pm.request.body.raw, pm.environment.get('demoSecret')).toString()
pm.request.headers.upsert({ key: 'X-Signature', value: signature })`,
      test: `const echoed = pm.response.json()
const expected = CryptoJS.HmacSHA256(echoed.data, pm.environment.get('demoSecret')).toString()
pm.test('Signature matches the body', () => pm.expect(echoed.headers['X-Signature']).to.eql(expected))`
    })
  ])

  const fun = folder('6 · Fun public APIs', 'Free APIs that need no key. Some have rate limits.', [
    req('Weather right now', 'GET', 'https://api.open-meteo.com/v1/forecast?latitude={{lat}}&longitude={{lon}}&current=temperature_2m,wind_speed_10m', {
      notes: 'Change lat and lon in the Demo environment to get another city.',
      test: `const now = pm.response.json().current
console.log(\`It is \${now.temperature_2m}°C with \${now.wind_speed_10m} km/h wind\`)
pm.test('Has a temperature', () => pm.expect(now.temperature_2m).to.be.a('number'))`
    }),
    req('Pokémon', 'GET', 'https://pokeapi.co/api/v2/pokemon/{{pokemon}}', {
      test: `const p = pm.response.json()
pm.test('Found it', () => pm.expect(p.name).to.eql(pm.environment.get('pokemon')))
console.log(p.name, 'types:', p.types.map((t) => t.type.name).join(', '))`
    }),
    req('Random dog photo', 'GET', 'https://dog.ceo/api/breeds/image/random', {
      test: `pm.test('Success', () => pm.response.to.have.jsonBody('status', 'success'))
console.log('Open this in your browser:', pm.response.json().message)`
    }),
    req('Cat fact', 'GET', 'https://catfact.ninja/fact'),
    req('Guess an age from a name', 'GET', 'https://api.agify.io?name={{firstName}}', {
      test: `const r = pm.response.json()
console.log(\`People called \${r.name} are on average \${r.age}\`)`
    }),
    req('Random joke', 'GET', 'https://official-joke-api.appspot.com/random_joke', {
      test: `const j = pm.response.json()
console.log(j.setup, '…', j.punchline)`
    }),
    req('GitHub repository', 'GET', 'https://api.github.com/repos/electron/electron', {
      notes: 'GitHub allows 60 unauthenticated requests per hour.',
      headers: [['Accept', 'application/vnd.github+json']],
      test: `const repo = pm.response.json()
pm.test('Has stars', () => pm.expect(repo.stargazers_count).to.be.above(0))
console.log(repo.full_name, '★', repo.stargazers_count)`
    }),
    req('Your public IP', 'GET', 'https://api.ipify.org?format=json')
  ])

  const collection = newCollection({
    name: 'Public API Tour',
    description:
      'A guided tour of FlosForge Caller using free public APIs. Work through the folders in order; each request explains itself in its Notes tab.',
    items: [crud, auth, bodies, responses, scripts, fun],
    auth: { type: 'none' },
    scripts: {
      preRequest: '',
      test: `// Collection-level test: runs after every request in the collection.
pm.test('No server error', () => pm.expect(pm.response.code).to.be.below(500))`
    },
    variables: [variable('tour', 'FlosForge Caller demo')]
  })

  const environment = newEnvironment({
    name: 'Demo',
    variables: [
      variable('jsonApi', 'https://jsonplaceholder.typicode.com'),
      variable('httpbin', 'https://httpbin.org'),
      variable('postId', '1'),
      variable('demoToken', 'demo-token-123', true, true),
      variable('demoApiKey', 'demo-key-456', true, true),
      variable('demoSecret', 'not-really-secret', true, true),
      variable('countryCode', 'GR'),
      variable('lat', '37.98'),
      variable('lon', '23.73'),
      variable('pokemon', 'pikachu'),
      variable('firstName', 'ada')
    ]
  })

  return { collection, environment }
}
