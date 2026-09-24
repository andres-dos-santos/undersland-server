import 'dotenv/config'
import { buildApp } from './app.js'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'

try {
  const app = await buildApp()
  await app.listen({ port, host })
} catch (error) {
  console.error(error)
  process.exit(1)
}
