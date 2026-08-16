import { loadConfig } from './config.js'
import { buildRelay } from './server.js'

const config = loadConfig()
const app = await buildRelay({ config })
await app.listen({ port: config.port, host: '0.0.0.0' })
console.log(`dashboardz-relay listening on :${config.port}`)
