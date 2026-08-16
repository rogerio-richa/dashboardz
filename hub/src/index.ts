import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { databaseHasProtectedSecrets, openDb, verifySecretStore } from './db/index.js'
import { boot } from './boot.js'
import { BRAND } from './brand.js'
import { createSecretBox } from './secrets/box.js'
import { loadMasterKey } from './secrets/masterKey.js'
import { installShutdownHandlers } from './shutdown.js'

const config = loadConfig()
mkdirSync(config.dataDir, { recursive: true })
const dbPath = join(config.dataDir, 'hub.db')
const allowCreate = !databaseHasProtectedSecrets(dbPath)
const secretBox = createSecretBox(loadMasterKey(config.dataDir, config.masterKey, { allowCreate }))
const db = openDb(dbPath, { secretBox })
verifySecretStore(db, secretBox)
// Before boot, not after: a signal arriving during startup should still close the database rather
// than be ignored because the handlers were not up yet.
installShutdownHandlers(db)
await boot(config, db, secretBox)
console.log(`${BRAND.name} hub listening on :${config.port}`)
