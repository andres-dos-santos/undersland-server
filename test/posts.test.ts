import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'

import { type MongoClient, ObjectId } from 'mongodb'
import { buildApp } from '../src/app.js'

const sessionSecret = 'test-session-secret'

function createSessionCookie(overrides: Partial<{ exp: number }> = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'google-user-id',
      email: 'user@example.com',
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
      ...overrides
    })
  ).toString('base64url')
  const signature = createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('base64url')

  return `understand-session=${payload}.${signature}`
}

function createMongoClient(
  posts: object[],
  news: object[] = [],
  users: object[] = []
) {
  let collectionName: string | undefined
  let databaseName: string | undefined
  let insertedPost: object | undefined
  let closed = false
  const insertedId = new ObjectId()

  const client = {
    async connect() {},
    db(name: string) {
      databaseName = name
      return {
        collection(name: string) {
          collectionName = name
          return {
            find() {
              return {
                async toArray() {
                  return news
                }
              }
            },
            async findOne(
              filter: { googleId?: string },
              options?: { projection?: { googleId?: number } }
            ) {
              const user = users.find(
                (candidate) =>
                  (candidate as { googleId?: string }).googleId ===
                  filter.googleId
              )

              if (!user) return null
              if (options?.projection?.googleId !== 0) return user

              const { googleId: _googleId, ...projectedUser } = user as {
                googleId?: string
                [key: string]: unknown
              }
              return projectedUser
            },
            aggregate() {
              return {
                async toArray() {
                  return posts
                }
              }
            },
            async insertOne(post: object) {
              insertedPost = post
              return { acknowledged: true, insertedId }
            },
            async updateOne() {
              return {
                acknowledged: true,
                matchedCount: 0,
                upsertedId: insertedId
              }
            }
          }
        }
      }
    },
    async close() {
      closed = true
    }
  } as unknown as MongoClient

  return {
    client,
    insertedId,
    state: () => ({ collectionName, databaseName, insertedPost, closed })
  }
}

test('GET /health reports that the service is healthy', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({ logger: false, mongoClient: mongo.client })

  const response = await app.inject({ method: 'GET', url: '/health' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok' })
  assert.equal(mongo.state().collectionName, undefined)

  await app.close()
})

test('GET /me returns the authenticated user', async () => {
  const user = {
    _id: new ObjectId(),
    googleId: 'google-user-id',
    name: 'Example User',
    email: 'user@example.com',
    picture: 'https://example.com/avatar.jpg'
  }
  const mongo = createMongoClient([], [], [user])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { cookie: createSessionCookie() }
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    _id: user._id.toHexString(),
    name: user.name,
    email: user.email,
    picture: user.picture
  })
  assert.equal(mongo.state().collectionName, 'Users')

  await app.close()
})

test('GET /me rejects unauthenticated users', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({ method: 'GET', url: '/me' })

  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { message: 'Authentication required' })
  assert.equal(mongo.state().collectionName, undefined)

  await app.close()
})

test('GET /me returns 404 when the session user no longer exists', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { cookie: createSessionCookie() }
  })

  assert.equal(response.statusCode, 404)
  assert.deepEqual(response.json(), { message: 'User not found' })

  await app.close()
})

test('GET /posts returns posts for an authenticated user', async () => {
  const posts = [
    { _id: 'post-1', title: 'First post' },
    { _id: 'post-2', title: 'Second post' }
  ]
  const mongo = createMongoClient(posts)
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({
    method: 'GET',
    url: '/posts',
    headers: { cookie: createSessionCookie() }
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), posts)
  assert.equal(mongo.state().databaseName, 'posts')
  assert.equal(mongo.state().collectionName, 'Posts')

  await app.close()
  assert.equal(mongo.state().closed, true)
})

test('GET /posts rejects unauthenticated users', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({ method: 'GET', url: '/posts' })

  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { message: 'Authentication required' })
  assert.equal(mongo.state().collectionName, undefined)

  await app.close()
})

test('GET /posts rejects an expired session', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({
    method: 'GET',
    url: '/posts',
    headers: { cookie: createSessionCookie({ exp: 1 }) }
  })

  assert.equal(response.statusCode, 401)
  assert.equal(mongo.state().collectionName, undefined)

  await app.close()
})

test('GET /news returns news for an authenticated user', async () => {
  const news = [
    { _id: 'news-1', title: 'First news item' },
    { _id: 'news-2', title: 'Second news item' }
  ]
  const mongo = createMongoClient([], news)
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({
    method: 'GET',
    url: '/news',
    headers: { cookie: createSessionCookie() }
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), news)
  assert.equal(mongo.state().databaseName, 'posts')
  assert.equal(mongo.state().collectionName, 'News')

  await app.close()
})

test('GET /news rejects unauthenticated users', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({ method: 'GET', url: '/news' })

  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { message: 'Authentication required' })
  assert.equal(mongo.state().collectionName, undefined)

  await app.close()
})

test('POST /news creates news for an authenticated user', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })
  const body = {
    title: 'New interface research',
    short_description: 'A concise summary of new interface research.',
    html: [
      '<p>Beginner article.</p>',
      '<p>Intermediate article.</p>',
      '<p>Advanced article.</p>'
    ],
    difficult_words: [['interface'], ['research'], ['methodology']],
    slug: 'new-interface-research',
    links: [{ link: 'https://example.com/article', text: 'Original article' }],
    author: { name: 'Example Author' },
    created_at: '2026-09-23T12:00:00.000Z'
  }

  const response = await app.inject({
    method: 'POST',
    url: '/news',
    headers: { cookie: createSessionCookie() },
    payload: body
  })

  assert.equal(response.statusCode, 201)
  assert.deepEqual(response.json(), {
    _id: mongo.insertedId.toHexString(),
    ...body
  })
  assert.deepEqual(mongo.state().insertedPost, {
    ...body,
    created_at: new Date(body.created_at)
  })
  assert.equal(mongo.state().collectionName, 'News')

  await app.close()
})

test('POST /news requires authentication', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({
    method: 'POST',
    url: '/news',
    payload: {}
  })

  assert.equal(response.statusCode, 401)
  assert.equal(mongo.state().insertedPost, undefined)

  await app.close()
})

test('POST /news validates its body', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    sessionSecret
  })

  const response = await app.inject({
    method: 'POST',
    url: '/news',
    headers: { cookie: createSessionCookie() },
    payload: { title: 'Incomplete news' }
  })

  assert.equal(response.statusCode, 400)
  assert.equal(mongo.state().insertedPost, undefined)

  await app.close()
})

test('GET /sign-up starts Google OAuth', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    googleClientId: 'google-client-id',
    googleClientSecret: 'google-client-secret'
  })

  const response = await app.inject({ method: 'GET', url: '/sign-up' })

  assert.equal(response.statusCode, 302)
  assert.match(response.headers.location ?? '', /accounts\.google\.com/)
  assert.match(response.headers.location ?? '', /client_id=google-client-id/)
  const oauthCookies = response.headers['set-cookie']
  const serializedCookies = Array.isArray(oauthCookies)
    ? oauthCookies.join('\n')
    : (oauthCookies ?? '')
  assert.match(serializedCookies, /Path=\/sign-up\/google\/callback/)
  assert.doesNotMatch(serializedCookies, /Domain=/)

  await app.close()
})

const googleProfile = {
  sub: 'google-user-id',
  name: 'Example User',
  email: 'USER@example.com',
  picture: 'https://example.com/avatar.jpg',
  email_verified: true
}

async function buildGoogleCallbackApp(nodeEnv: 'development' | 'production') {
  const mongo = createMongoClient([])
  const app = await buildApp({
    logger: false,
    mongoClient: mongo.client,
    googleClientId: 'google-client-id',
    googleClientSecret: 'google-client-secret',
    frontendUrl:
      nodeEnv === 'production'
        ? 'https://www.undersland.com'
        : 'http://localhost:3000',
    sessionSecret,
    nodeEnv,
    googleAccessTokenProvider: async () => 'test-access-token',
    googleProfileProvider: async () => googleProfile
  })

  return { app, mongo }
}

test('Google callback sets a cross-subdomain production session cookie and redirects home', async () => {
  const { app } = await buildGoogleCallbackApp('production')

  const response = await app.inject({
    method: 'GET',
    url: '/sign-up/google/callback?code=test-code'
  })

  assert.equal(response.statusCode, 302)
  assert.equal(response.headers.location, 'https://www.undersland.com/')
  const cookie = response.headers['set-cookie'] as string
  assert.match(cookie, /^understand-session=[^.]+\.[^;]+;/)
  assert.match(cookie, /Domain=\.undersland\.com/)
  assert.match(cookie, /Path=\//)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /Secure/)
  assert.match(cookie, /SameSite=Lax/)

  await app.close()
})

test('Google callback keeps the development session cookie localhost-compatible', async () => {
  const { app } = await buildGoogleCallbackApp('development')

  const response = await app.inject({
    method: 'GET',
    url: '/sign-up/google/callback?code=test-code'
  })

  assert.equal(response.statusCode, 302)
  assert.equal(response.headers.location, 'http://localhost:3000/')
  const cookie = response.headers['set-cookie'] as string
  assert.doesNotMatch(cookie, /Domain=/)
  assert.doesNotMatch(cookie, /; Secure/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Path=\//)

  await app.close()
})

test('Google callback redirects failures with only a safe error code', async () => {
  const { app } = await buildGoogleCallbackApp('production')

  const response = await app.inject({
    method: 'GET',
    url: '/sign-up/google/callback?error=access_denied&error_description=private-provider-detail'
  })

  assert.equal(response.statusCode, 302)
  assert.equal(
    response.headers.location,
    'https://www.undersland.com/login?error=oauth_denied'
  )
  assert.doesNotMatch(
    response.headers.location ?? '',
    /private-provider-detail/
  )

  await app.close()
})

test('Google callback session signature is accepted by authenticated routes', async () => {
  const { app } = await buildGoogleCallbackApp('production')
  const callbackResponse = await app.inject({
    method: 'GET',
    url: '/sign-up/google/callback?code=test-code'
  })
  const sessionCookie = (
    callbackResponse.headers['set-cookie'] as string
  ).split(';', 1)[0]
  assert.ok(sessionCookie)
  const sessionValue = sessionCookie.slice('understand-session='.length)
  const signatureSeparator = sessionValue.lastIndexOf('.')
  assert.notEqual(signatureSeparator, -1)
  const payload = sessionValue.slice(0, signatureSeparator)
  const signature = sessionValue.slice(signatureSeparator + 1)
  assert.equal(
    signature,
    createHmac('sha256', sessionSecret).update(payload).digest('base64url')
  )

  const response = await app.inject({
    method: 'GET',
    url: '/me',
    headers: { cookie: sessionCookie }
  })

  assert.equal(response.statusCode, 404)

  await app.close()
})

test('POST /posts creates and returns a post', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({ logger: false, mongoClient: mongo.client })
  const body = {
    title: 'Laws of UX',
    slug: 'laws-of-ux',
    authorId: '1',
    short_description: 'Psychological principles behind interfaces',
    html: '<p>Post content</p>',
    created_at: '2026-09-18T12:00:00.000Z'
  }

  const response = await app.inject({
    method: 'POST',
    url: '/posts',
    payload: body
  })

  assert.equal(response.statusCode, 201)
  assert.deepEqual(response.json(), {
    _id: mongo.insertedId.toHexString(),
    ...body
  })
  assert.deepEqual(mongo.state().insertedPost, {
    ...body,
    created_at: new Date(body.created_at)
  })
  assert.equal(mongo.state().collectionName, 'Posts')

  await app.close()
})

test('POST /posts validates its body', async () => {
  const mongo = createMongoClient([])
  const app = await buildApp({ logger: false, mongoClient: mongo.client })

  const response = await app.inject({
    method: 'POST',
    url: '/posts',
    payload: { title: 'Incomplete post' }
  })

  assert.equal(response.statusCode, 400)
  assert.equal(mongo.state().insertedPost, undefined)

  await app.close()
})
