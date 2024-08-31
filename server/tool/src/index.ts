//
// Copyright © 2022 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import contact from '@hcengineering/contact'
import core, {
  BackupClient,
  Branding,
  Client as CoreClient,
  coreId,
  DOMAIN_BENCHMARK,
  DOMAIN_MIGRATION,
  DOMAIN_MODEL,
  DOMAIN_TRANSIENT,
  DOMAIN_TX,
  groupByArray,
  Hierarchy,
  MeasureContext,
  MigrationState,
  ModelDb,
  systemAccountEmail,
  toWorkspaceString,
  Tx,
  TxOperations,
  WorkspaceId,
  WorkspaceIdWithUrl,
  type Doc,
  type TxCUD
} from '@hcengineering/core'
import { consoleModelLogger, MigrateOperation, ModelLogger, tryMigrate } from '@hcengineering/model'
import { createMongoTxAdapter, DBCollectionHelper, getMongoClient, getWorkspaceDB } from '@hcengineering/mongo'
import {
  AggregatorStorageAdapter,
  DomainIndexHelperImpl,
  StorageAdapter,
  StorageConfiguration
} from '@hcengineering/server-core'
import { buildStorageFromConfig, storageConfigFromEnv } from '@hcengineering/server-storage'
import { Db, Document } from 'mongodb'
import { connect } from './connect'
import { InitScript, WorkspaceInitializer } from './initializer'
import toolPlugin from './plugin'
import { MigrateClientImpl } from './upgrade'

import { getMetadata } from '@hcengineering/platform'
import { generateToken } from '@hcengineering/server-token'
import fs from 'fs'
import * as yaml from 'js-yaml'
import path from 'path'

export * from './connect'
export * from './plugin'
export { toolPlugin as default }

export class FileModelLogger implements ModelLogger {
  handle: fs.WriteStream
  constructor (readonly file: string) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })

    this.handle = fs.createWriteStream(this.file, { flags: 'a' })
  }

  log (msg: string, data: any): void {
    this.handle.write(msg + ' : ' + JSON.stringify(data) + '\n')
  }

  error (msg: string, data: any): void {
    this.handle.write(msg + ': ' + JSON.stringify(data) + '\n')
  }

  close (): void {
    this.handle.close()
  }
}

/**
 * @public
 */
export function prepareTools (rawTxes: Tx[]): {
  mongodbUri: string
  txes: Tx[]
} {
  const mongodbUri = process.env.MONGO_URL
  if (mongodbUri === undefined) {
    console.error('please provide mongodb url.')
    process.exit(1)
  }

  return {
    mongodbUri,
    txes: JSON.parse(JSON.stringify(rawTxes)) as Tx[]
  }
}

/**
 * @public
 */
export async function initModel (
  ctx: MeasureContext,
  workspaceId: WorkspaceId,
  rawTxes: Tx[],
  logger: ModelLogger = consoleModelLogger,
  progress: (value: number) => Promise<void>
): Promise<void> {
  const { mongodbUri, txes } = prepareTools(rawTxes)
  if (txes.some((tx) => tx.objectSpace !== core.space.Model)) {
    throw Error('Model txes must target only core.space.Model')
  }

  const _client = getMongoClient(mongodbUri)
  const client = await _client.getClient()
  const storageConfig: StorageConfiguration = storageConfigFromEnv()
  const storageAdapter = buildStorageFromConfig(storageConfig, mongodbUri)
  try {
    const db = getWorkspaceDB(client, workspaceId)

    logger.log('creating model...', workspaceId)
    const result = await db.collection(DOMAIN_TX).insertMany(txes as Document[])
    logger.log('model transactions inserted.', { count: result.insertedCount })

    await progress(30)

    logger.log('creating data...', { workspaceId })

    await progress(60)

    logger.log('create minio bucket', { workspaceId })

    await storageAdapter.make(ctx, workspaceId)
    await progress(100)
  } catch (err: any) {
    ctx.error('Failed to create workspace', { error: err })
    throw err
  } finally {
    await storageAdapter.close()
    _client.close()
  }
}

export async function updateModel (
  ctx: MeasureContext,
  workspaceId: WorkspaceId,
  migrateOperations: [string, MigrateOperation][],
  connection: TxOperations,
  logger: ModelLogger = consoleModelLogger,
  progress: (value: number) => Promise<void>
): Promise<void> {
  logger.log('connecting to transactor', { workspaceId })

  const states = await connection.findAll<MigrationState>(core.class.MigrationState, {})
  const sts = Array.from(groupByArray(states, (it) => it.plugin).entries())
  const migrateState = new Map(sts.map((it) => [it[0], new Set(it[1].map((q) => q.state))]))

  const { mongodbUri } = prepareTools([])

  const _client = getMongoClient(mongodbUri)
  const client = await _client.getClient()

  try {
    const db = getWorkspaceDB(client, workspaceId)

    let i = 0
    for (const op of migrateOperations) {
      logger.log('Migrate', { name: op[0] })
      await op[1].upgrade(migrateState, async () => connection as any, logger)
      i++
      await progress((((100 / migrateOperations.length) * i) / 100) * 30)
    }

    // Create update indexes
    await createUpdateIndexes(
      ctx,
      connection.getHierarchy(),
      connection.getModel(),
      db,
      logger,
      async (value) => {
        await progress(30 + (Math.min(value, 100) / 100) * 70)
      },
      workspaceId
    )
    await progress(100)
  } catch (e: any) {
    logger.error('error', { error: e })
    throw e
  } finally {
    _client.close()
  }
}

/**
 * @public
 */
export async function initializeWorkspace (
  ctx: MeasureContext,
  branding: Branding | null,
  wsUrl: WorkspaceIdWithUrl,
  storageAdapter: AggregatorStorageAdapter,
  client: TxOperations,
  logger: ModelLogger = consoleModelLogger,
  progress: (value: number) => Promise<void>
): Promise<void> {
  const initWS = branding?.initWorkspace ?? getMetadata(toolPlugin.metadata.InitWorkspace)
  const sriptUrl = getMetadata(toolPlugin.metadata.InitScriptURL)
  if (initWS === undefined || sriptUrl === undefined) return
  try {
    // `https://raw.githubusercontent.com/hcengineering/init/main/script.yaml`
    const req = await fetch(sriptUrl)
    const text = await req.text()
    const scripts = yaml.load(text) as any as InitScript[]
    let script: InitScript | undefined
    if (initWS !== undefined) {
      script = scripts.find((it) => it.name === initWS)
    }
    if (script === undefined) {
      script = scripts.find((it) => it.default)
    }
    if (script === undefined) {
      return
    }

    const initializer = new WorkspaceInitializer(ctx, storageAdapter, wsUrl, client)
    await initializer.processScript(script, logger, progress)
  } catch (err: any) {
    ctx.error('Failed to create workspace', { error: err })
    throw err
  }
}

/**
 * @public
 */
export async function upgradeModel (
  ctx: MeasureContext,
  transactorUrl: string,
  workspaceId: WorkspaceId,
  rawTxes: Tx[],
  migrateOperations: [string, MigrateOperation][],
  logger: ModelLogger = consoleModelLogger,
  skipTxUpdate: boolean = false,
  progress: (value: number) => Promise<void>,
  forceIndexes: boolean = false
): Promise<Tx[]> {
  const { mongodbUri, txes } = prepareTools(rawTxes)

  if (txes.some((tx) => tx.objectSpace !== core.space.Model)) {
    throw Error('Model txes must target only core.space.Model')
  }

  const _client = getMongoClient(mongodbUri)
  const client = await _client.getClient()
  const storageConfig: StorageConfiguration = storageConfigFromEnv()
  const storageAdapter = buildStorageFromConfig(storageConfig, mongodbUri)

  try {
    const db = getWorkspaceDB(client, workspaceId)

    const prevModel = await fetchModelFromMongo(ctx, mongodbUri, workspaceId)
    const { migrateClient: preMigrateClient } = await prepareMigrationClient(
      db,
      prevModel.hierarchy,
      prevModel.modelDb,
      logger,
      storageAdapter,
      workspaceId
    )

    await progress(0)
    await ctx.with('pre-migrate', {}, async (ctx) => {
      let i = 0
      for (const op of migrateOperations) {
        if (op[1].preMigrate === undefined) {
          continue
        }
        const preMigrate = op[1].preMigrate

        const t = Date.now()
        try {
          await ctx.with(op[0], {}, async (ctx) => {
            await preMigrate(preMigrateClient, logger)
          })
        } catch (err: any) {
          logger.error(`error during pre-migrate: ${op[0]} ${err.message}`, err)
          throw err
        }
        logger.log('pre-migrate:', { workspaceId: workspaceId.name, operation: op[0], time: Date.now() - t })
        await progress(((100 / migrateOperations.length) * i * 10) / 100)
        i++
      }
    })

    if (!skipTxUpdate) {
      logger.log('removing model...', { workspaceId: workspaceId.name })
      await progress(10)
      // we're preserving accounts (created by core.account.System).
      const result = await ctx.with(
        'mongo-delete',
        {},
        async () =>
          await db.collection(DOMAIN_TX).deleteMany({
            objectSpace: core.space.Model,
            modifiedBy: core.account.System,
            objectClass: { $nin: [contact.class.PersonAccount, 'contact:class:EmployeeAccount'] }
          })
      )
      logger.log('transactions deleted.', { workspaceId: workspaceId.name, count: result.deletedCount })
      logger.log('creating model...', { workspaceId: workspaceId.name })
      const insert = await ctx.with(
        'mongo-insert',
        {},
        async () => await db.collection(DOMAIN_TX).insertMany(txes as Document[])
      )

      logger.log('model transactions inserted.', { workspaceId: workspaceId.name, count: insert.insertedCount })
      await progress(20)
    }
    const newModel = [
      ...txes,
      ...Array.from(
        prevModel.model.filter(
          (it) =>
            it.modifiedBy !== core.account.System ||
            (it as TxCUD<Doc>).objectClass === contact.class.Person ||
            (it as TxCUD<Doc>).objectClass === 'contact:class:PersonAccount'
        )
      )
    ]

    const { hierarchy, modelDb, model } = await fetchModelFromMongo(ctx, mongodbUri, workspaceId, newModel)
    const { migrateClient, migrateState } = await prepareMigrationClient(
      db,
      hierarchy,
      modelDb,
      logger,
      storageAdapter,
      workspaceId
    )

    const upgradeIndexes = async (): Promise<void> => {
      ctx.info('Migrate indexes')
      // Create update indexes
      await createUpdateIndexes(
        ctx,
        hierarchy,
        modelDb,
        db,
        logger,
        async (value) => {
          await progress(90 + (Math.min(value, 100) / 100) * 10)
        },
        workspaceId
      )
    }
    if (forceIndexes) {
      await upgradeIndexes()
    }

    await ctx.with('migrate', {}, async (ctx) => {
      let i = 0
      for (const op of migrateOperations) {
        const t = Date.now()
        try {
          await ctx.with(op[0], {}, async () => {
            await op[1].migrate(migrateClient, logger)
          })
        } catch (err: any) {
          logger.error(`error during migrate: ${op[0]} ${err.message}`, err)
          throw err
        }
        logger.log('migrate:', { workspaceId: workspaceId.name, operation: op[0], time: Date.now() - t })
        await progress(20 + ((100 / migrateOperations.length) * i * 20) / 100)
        i++
      }

      await tryMigrate(migrateClient, coreId, [
        {
          state: 'indexes-v4',
          func: upgradeIndexes
        }
      ])
    })

    logger.log('Apply upgrade operations', { workspaceId: workspaceId.name })

    let connection: (CoreClient & BackupClient) | undefined
    const getUpgradeClient = async (): Promise<CoreClient & BackupClient> =>
      await ctx.with('connect-platform', {}, async (ctx) => {
        if (connection !== undefined) {
          return connection
        }
        connection = (await connect(
          transactorUrl,
          workspaceId,
          undefined,
          {
            mode: 'backup',
            model: 'upgrade',
            admin: 'true'
          },
          model
        )) as CoreClient & BackupClient
        return connection
      })
    try {
      await ctx.with('upgrade', {}, async (ctx) => {
        let i = 0
        for (const op of migrateOperations) {
          const t = Date.now()
          await ctx.with(op[0], {}, async () => {
            await op[1].upgrade(migrateState, getUpgradeClient, logger)
          })
          logger.log('upgrade:', { operation: op[0], time: Date.now() - t, workspaceId: workspaceId.name })
          await progress(60 + ((100 / migrateOperations.length) * i * 30) / 100)
          i++
        }
      })

      if (connection === undefined) {
        // We need to send reboot for workspace
        ctx.info('send force close', { workspace: workspaceId.name, transactorUrl })
        const serverEndpoint = transactorUrl.replaceAll('wss://', 'https://').replace('ws://', 'http://')
        const token = generateToken(systemAccountEmail, workspaceId, { admin: 'true' })
        await fetch(
          serverEndpoint + `/api/v1/manage?token=${token}&operation=force-close&wsId=${toWorkspaceString(workspaceId)}`,
          {
            method: 'PUT'
          }
        )
      }
    } finally {
      await connection?.sendForceClose()
      await connection?.close()
    }
    return model
  } finally {
    await storageAdapter.close()
    _client.close()
  }
}

async function prepareMigrationClient (
  db: Db,
  hierarchy: Hierarchy,
  model: ModelDb,
  logger: ModelLogger,
  storageAdapter: StorageAdapter,
  workspaceId: WorkspaceId
): Promise<{
    migrateClient: MigrateClientImpl
    migrateState: Map<string, Set<string>>
  }> {
  const migrateClient = new MigrateClientImpl(db, hierarchy, model, logger, storageAdapter, workspaceId)
  const states = await migrateClient.find<MigrationState>(DOMAIN_MIGRATION, { _class: core.class.MigrationState })
  const sts = Array.from(groupByArray(states, (it) => it.plugin).entries())
  const migrateState = new Map(sts.map((it) => [it[0], new Set(it[1].map((q) => q.state))]))
  migrateClient.migrateState = migrateState

  return { migrateClient, migrateState }
}

export async function fetchModelFromMongo (
  ctx: MeasureContext,
  mongodbUri: string,
  workspaceId: WorkspaceId,
  model?: Tx[]
): Promise<{ hierarchy: Hierarchy, modelDb: ModelDb, model: Tx[] }> {
  const hierarchy = new Hierarchy()
  const modelDb = new ModelDb(hierarchy)

  const txAdapter = await createMongoTxAdapter(ctx, hierarchy, mongodbUri, workspaceId, modelDb)

  try {
    model = model ?? (await ctx.with('get-model', {}, async (ctx) => await txAdapter.getModel(ctx)))

    await ctx.with('build local model', {}, async () => {
      for (const tx of model ?? []) {
        try {
          hierarchy.tx(tx)
        } catch (err: any) {}
      }
      modelDb.addTxes(ctx, model as Tx[], false)
    })
  } finally {
    await txAdapter.close()
  }
  return { hierarchy, modelDb, model }
}

async function createUpdateIndexes (
  ctx: MeasureContext,
  hierarchy: Hierarchy,
  model: ModelDb,
  db: Db,
  logger: ModelLogger,
  progress: (value: number) => Promise<void>,
  workspaceId: WorkspaceId
): Promise<void> {
  const domainHelper = new DomainIndexHelperImpl(ctx, hierarchy, model, workspaceId)
  const dbHelper = new DBCollectionHelper(db)
  await dbHelper.init()
  let completed = 0
  const allDomains = hierarchy.domains()
  for (const domain of allDomains) {
    if (domain === DOMAIN_MODEL || domain === DOMAIN_TRANSIENT || domain === DOMAIN_BENCHMARK) {
      continue
    }
    await domainHelper.checkDomain(ctx, domain, await dbHelper.estimatedCount(domain), dbHelper)
    completed++
    await progress((100 / allDomains.length) * completed)
  }
}
