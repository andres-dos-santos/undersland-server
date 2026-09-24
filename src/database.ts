import Fastify from 'fastify'
import { MongoClient } from 'mongodb'

const defaultMongoUri =
  'mongodb://admin:senha123@localhost:27017/posts?authSource=admin'

interface BuildAppOptions {
  logger?: boolean
  mongoUri?: string
  databaseName?: string
  mongoClient?: MongoClient
}

interface CreatePostBody {
  title: string
  slug: string
  authorId: string
  short_description: string
  html: string
  created_at?: string
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true })
  const mongoUri =
    options.mongoUri ?? process.env.MONGODB_URI ?? defaultMongoUri
  const databaseName =
    options.databaseName ?? process.env.MONGODB_DATABASE ?? 'posts'
  const mongoClient = options.mongoClient ?? new MongoClient(mongoUri)

  await mongoClient.connect()

  const database = mongoClient.db(databaseName)
  app.decorate('mongo', { client: mongoClient, db: database })

  app.addHook('onClose', async () => {
    await mongoClient.close()
  })

  app.get('/posts', async () => {
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
  })

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
