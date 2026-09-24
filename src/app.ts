import { createHmac, timingSafeEqual } from 'node:crypto'
import oauthPlugin from '@fastify/oauth2'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { MongoClient } from 'mongodb'

function getMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI

  const username = process.env.MONGODB_USERNAME
  const password = process.env.MONGODB_PASSWORD
  const host = process.env.MONGODB_HOST ?? 'localhost'

  if (username && password) {
    return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:27017/?authSource=admin`
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'MONGODB_URI or MONGODB_USERNAME and MONGODB_PASSWORD are required in production'
    )
  }

  return 'mongodb://localhost:27017/posts'
}

interface BuildAppOptions {
  logger?: boolean
  mongoUri?: string
  databaseName?: string
  mongoClient?: MongoClient
  googleClientId?: string
  googleClientSecret?: string
  googleCallbackUrl?: string
  frontendUrl?: string
  sessionSecret?: string
}

interface CreatePostBody {
  title: string
  slug: string
  authorId: string
  short_description: string
  html: string
  created_at?: string
}

interface CreateNewsBody {
  title: string
  short_description: string
  html: string[]
  difficult_words: string[][]
  slug: string
  links: Array<{ link: string; text: string }>
  author: { name: string }
  created_at?: string
}

interface GoogleProfile {
  sub: string
  name: string
  email: string
  picture?: string
  email_verified: boolean
}

interface SessionPayload {
  sub: string
  email: string
  exp: number
}

function getCookie(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return undefined

  for (const cookie of cookieHeader.split(';')) {
    const separatorIndex = cookie.indexOf('=')
    if (separatorIndex === -1) continue

    const cookieName = cookie.slice(0, separatorIndex).trim()
    if (cookieName === name) {
      return cookie.slice(separatorIndex + 1).trim()
    }
  }

  return undefined
}

function getValidSession(cookieHeader: string | undefined, secret: string) {
  const session = getCookie(cookieHeader, 'understand-session')
  if (!session) return undefined

  const separatorIndex = session.lastIndexOf('.')
  if (separatorIndex === -1) return undefined

  const payload = session.slice(0, separatorIndex)
  const providedSignature = session.slice(separatorIndex + 1)
  const expectedSignature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url')
  const providedBuffer = Buffer.from(providedSignature)
  const expectedBuffer = Buffer.from(expectedSignature)

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return undefined
  }

  try {
    const sessionPayload = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as Partial<SessionPayload>

    if (
      typeof sessionPayload.sub === 'string' &&
      typeof sessionPayload.email === 'string' &&
      typeof sessionPayload.exp === 'number' &&
      sessionPayload.exp > Math.floor(Date.now() / 1000)
    ) {
      return sessionPayload as SessionPayload
    }

    return undefined
  } catch {
    return undefined
  }
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true })
  const mongoUri = options.mongoUri ?? getMongoUri()
  const databaseName =
    options.databaseName ?? process.env.MONGODB_DATABASE ?? 'posts'
  const mongoClient = options.mongoClient ?? new MongoClient(mongoUri)

  await mongoClient.connect()

  const database = mongoClient.db(databaseName)
  app.decorate('mongo', { client: mongoClient, db: database })

  app.addHook('onClose', async () => {
    await mongoClient.close()
  })

  const googleClientId = options.googleClientId ?? process.env.GOOGLE_CLIENT_ID
  const googleClientSecret =
    options.googleClientSecret ?? process.env.GOOGLE_CLIENT_SECRET
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET
  const requireAuthentication = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    if (
      !sessionSecret ||
      !getValidSession(request.headers.cookie, sessionSecret)
    ) {
      return reply.status(401).send({ message: 'Authentication required' })
    }
  }

  app.get('/health', async () => ({ status: 'ok' }))

  if (googleClientId && googleClientSecret) {
    const callbackUrl =
      options.googleCallbackUrl ??
      process.env.GOOGLE_CALLBACK_URL ??
      'http://localhost:3001/sign-up/google/callback'
    const frontendUrl =
      options.frontendUrl ?? process.env.FRONTEND_URL ?? 'http://localhost:3000'

    await app.register(oauthPlugin, {
      name: 'googleOAuth2',
      scope: ['openid', 'profile', 'email'],
      credentials: {
        client: { id: googleClientId, secret: googleClientSecret },
        auth: {
          authorizeHost: 'https://accounts.google.com',
          authorizePath: '/o/oauth2/v2/auth',
          tokenHost: 'https://oauth2.googleapis.com',
          tokenPath: '/token'
        }
      },
      startRedirectPath: '/sign-up',
      callbackUri: callbackUrl,
      pkce: 'S256'
    })

    app.get('/sign-up/google/callback', async (request, reply) => {
      const query = request.query as {
        code?: string
        error?: string
        error_description?: string
      }

      request.log.info(
        {
          hasAuthorizationCode: Boolean(query.code),
          oauthError: query.error,
          oauthErrorDescription: query.error_description
        },
        'Google OAuth callback received'
      )

      const { token } =
        await app.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(
          request,
          reply
        )
      const profileResponse = await fetch(
        'https://openidconnect.googleapis.com/v1/userinfo',
        { headers: { authorization: `Bearer ${token.access_token}` } }
      )

      if (!profileResponse.ok) {
        return reply.status(502).send({ message: 'Could not load Google user' })
      }

      const profile = (await profileResponse.json()) as GoogleProfile

      if (!profile.email_verified) {
        return reply
          .status(403)
          .send({ message: 'Google email is not verified' })
      }

      const now = new Date()
      await database.collection('Users').updateOne(
        { googleId: profile.sub },
        {
          $set: {
            name: profile.name,
            email: profile.email.toLowerCase(),
            picture: profile.picture,
            updated_at: now
          },
          $setOnInsert: { googleId: profile.sub, created_at: now }
        },
        { upsert: true }
      )

      if (!sessionSecret) {
        request.log.error('SESSION_SECRET is required to create a session')
        return reply.status(500).send({ message: 'Session is not configured' })
      }

      const sessionPayload = Buffer.from(
        JSON.stringify({
          sub: profile.sub,
          email: profile.email.toLowerCase(),
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
        })
      ).toString('base64url')
      const sessionSignature = createHmac('sha256', sessionSecret)
        .update(sessionPayload)
        .digest('base64url')
      const secureCookie =
        process.env.NODE_ENV === 'production' ? '; Secure' : ''

      reply.header(
        'set-cookie',
        `understand-session=${sessionPayload}.${sessionSignature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secureCookie}`
      )

      return reply.redirect(new URL('/', frontendUrl).toString())
    })
  }

  app.get(
    '/me',
    { onRequest: requireAuthentication },
    async (request, reply) => {
      const session = getValidSession(
        request.headers.cookie,
        sessionSecret as string
      )
      const user = await database.collection('Users').findOne(
        { googleId: session?.sub },
        {
          projection: {
            googleId: 0
          }
        }
      )

      if (!user) {
        return reply.status(404).send({ message: 'User not found' })
      }

      return user
    }
  )

  app.get(
    '/posts',
    {
      onRequest: requireAuthentication
    },
    async () => {
      return database
        .collection('Posts')
        .aggregate([
          {
            $lookup: {
              from: 'Users',
              let: { authorId: '$authorId' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: [
                        '$_id',
                        {
                          $convert: {
                            input: '$$authorId',
                            to: 'objectId',
                            onError: null,
                            onNull: null
                          }
                        }
                      ]
                    }
                  }
                }
              ],
              as: 'author'
            }
          },
          {
            $unwind: {
              path: '$author',
              preserveNullAndEmptyArrays: true
            }
          },
          {
            $project: {
              title: 1,
              slug: 1,
              short_description: 1,
              html: 1,
              links: 1,
              created_at: 1,
              'author._id': 1,
              'author.name': 1
            }
          }
        ])
        .toArray()
    }
  )

  app.get('/news', { onRequest: requireAuthentication }, async () =>
    database.collection('News').find({}).toArray()
  )

  app.post<{ Body: CreateNewsBody }>(
    '/news',
    {
      onRequest: requireAuthentication,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'title',
            'short_description',
            'html',
            'difficult_words',
            'slug',
            'links',
            'author'
          ],
          properties: {
            title: { type: 'string', minLength: 1 },
            short_description: { type: 'string', minLength: 1, maxLength: 180 },
            html: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: { type: 'string', minLength: 1 }
            },
            difficult_words: {
              type: 'array',
              minItems: 3,
              maxItems: 3,
              items: {
                type: 'array',
                items: { type: 'string', minLength: 1 }
              }
            },
            slug: {
              type: 'string',
              minLength: 1,
              pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$'
            },
            links: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['link', 'text'],
                properties: {
                  link: { type: 'string', format: 'uri' },
                  text: { type: 'string', minLength: 1 }
                }
              }
            },
            author: {
              type: 'object',
              additionalProperties: false,
              required: ['name'],
              properties: { name: { type: 'string', minLength: 1 } }
            },
            created_at: { type: 'string', format: 'date-time' }
          }
        }
      }
    },
    async (request, reply) => {
      const news = {
        ...request.body,
        created_at: request.body.created_at
          ? new Date(request.body.created_at)
          : new Date()
      }
      const result = await database.collection('News').insertOne(news)

      return reply.status(201).send({ _id: result.insertedId, ...news })
    }
  )

  app.get('/posts/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string }

    const posts = await database
      .collection('Posts')
      .aggregate([
        { $match: { slug } },
        {
          $lookup: {
            from: 'Users',
            let: { authorId: '$authorId' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: [
                      '$_id',
                      {
                        $convert: {
                          input: '$$authorId',
                          to: 'objectId',
                          onError: null,
                          onNull: null
                        }
                      }
                    ]
                  }
                }
              }
            ],
            as: 'author'
          }
        },
        { $unwind: { path: '$author', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            title: 1,
            slug: 1,
            short_description: 1,
            html: 1,
            links: 1,
            created_at: 1,
            'author._id': 1,
            'author.name': 1
          }
        }
      ])
      .toArray()

    if (posts.length === 0) {
      return reply.status(404).send({ message: 'Post not found' })
    }

    return posts[0]
  })

  app.post<{ Body: CreatePostBody }>(
    '/posts',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'slug', 'authorId', 'short_description', 'html'],
          properties: {
            title: { type: 'string', minLength: 1 },
            slug: { type: 'string', minLength: 1 },
            authorId: { type: 'string', minLength: 1 },
            short_description: { type: 'string', minLength: 1 },
            html: { type: 'string', minLength: 1 },
            created_at: { type: 'string', format: 'date-time' }
          }
        }
      }
    },
    async (request, reply) => {
      const post = {
        ...request.body,
        created_at: request.body.created_at
          ? new Date(request.body.created_at)
          : new Date()
      }

      const result = await database.collection('Posts').insertOne(post)

      return reply.status(201).send({
        _id: result.insertedId,
        ...post
      })
    }
  )

  return app
}
