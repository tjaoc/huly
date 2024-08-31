//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021 Hardcore Engineering Inc.
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

import { Analytics } from '@hcengineering/analytics'
import core, {
  AttachedDoc,
  BackupClient,
  Client as CoreClient,
  Doc,
  Domain,
  DOMAIN_BLOB,
  DOMAIN_DOC_INDEX_STATE,
  DOMAIN_FULLTEXT_BLOB,
  DOMAIN_MODEL,
  DOMAIN_TRANSIENT,
  MeasureContext,
  MeasureMetricsContext,
  RateLimiter,
  Ref,
  SortingOrder,
  systemAccountEmail,
  TxCollectionCUD,
  WorkspaceId,
  type Blob,
  type DocIndexState
} from '@hcengineering/core'
import { BlobClient, createClient } from '@hcengineering/server-client'
import { fullTextPushStagePrefix, type StorageAdapter } from '@hcengineering/server-core'
import { generateToken } from '@hcengineering/server-token'
import { connect } from '@hcengineering/server-tool'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { createGzip } from 'node:zlib'
import { join } from 'path'
import { Writable } from 'stream'
import { extract, Pack, pack } from 'tar-stream'
import { createGunzip, gunzipSync, gzipSync } from 'zlib'
import { BackupStorage } from './storage'
export * from './storage'

const dataBlobSize = 50 * 1024 * 1024
const dataUploadSize = 2 * 1024 * 1024
const retrieveChunkSize = 2 * 1024 * 1024

const defaultLevel = 1

/**
 * Blob data from s3 storage
 * @public
 */
interface BlobData extends Doc {
  name: string
  size: number
  type: string
  provider?: string // If node defined, will be default one
  base64Data: string // base64 encoded data
}

/**
 * @public
 */
export interface Snapshot {
  added: Map<Ref<Doc>, string>
  updated: Map<Ref<Doc>, string>
  removed: Ref<Doc>[]
}

/**
 * @public
 */
export interface SnapshotV6 {
  added: Record<Ref<Doc>, string>
  updated: Record<Ref<Doc>, string>
  removed: Ref<Doc>[]
}

/**
 * @public
 */
export interface DomainData {
  snapshot?: string // 0.6 json snapshot
  snapshots?: string[]
  storage?: string[]

  // Some statistics
  added: number
  updated: number
  removed: number
}

/**
 * @public
 */
export interface BackupSnapshot {
  // _id => hash of added items.
  domains: Record<Domain, DomainData>
  date: number
}

/**
 * @public
 */
export interface BackupInfo {
  workspace: string
  version: string
  snapshots: BackupSnapshot[]
  snapshotsIndex?: number
  lastTxId?: string
}

async function loadDigest (
  ctx: MeasureContext,
  storage: BackupStorage,
  snapshots: BackupSnapshot[],
  domain: Domain,
  date?: number
): Promise<Map<Ref<Doc>, string>> {
  ctx = ctx.newChild('load digest', { domain, count: snapshots.length })
  const result = new Map<Ref<Doc>, string>()
  for (const s of snapshots) {
    const d = s.domains[domain]

    // Load old JSON snapshot
    if (d?.snapshot !== undefined) {
      const dChanges: SnapshotV6 = JSON.parse(gunzipSync(await storage.loadFile(d.snapshot)).toString())
      for (const [k, v] of Object.entries(dChanges.added)) {
        result.set(k as Ref<Doc>, v)
      }
      for (const [k, v] of Object.entries(dChanges.updated)) {
        result.set(k as Ref<Doc>, v)
      }
      for (const d of dChanges.removed) {
        result.delete(d)
      }
    }
    for (const snapshot of d?.snapshots ?? []) {
      try {
        const dataBlob = gunzipSync(await storage.loadFile(snapshot))
          .toString()
          .split('\n')
        const addedCount = parseInt(dataBlob.shift() ?? '0')
        const added = dataBlob.splice(0, addedCount)
        for (const it of added) {
          const [k, v] = it.split(';')
          result.set(k as Ref<Doc>, v)
        }

        const updatedCount = parseInt(dataBlob.shift() ?? '0')
        const updated = dataBlob.splice(0, updatedCount)
        for (const it of updated) {
          const [k, v] = it.split(';')
          result.set(k as Ref<Doc>, v)
        }

        const removedCount = parseInt(dataBlob.shift() ?? '0')
        const removed = dataBlob.splice(0, removedCount)
        for (const k of removed) {
          result.delete(k as Ref<Doc>)
        }
      } catch (err: any) {
        ctx.error('digest is broken, will do full backup for', { domain })
      }
    }
    // Stop if stop date is matched and provided
    if (date !== undefined && date === s.date) {
      break
    }
  }
  ctx.end()
  return result
}

async function write (chunk: any, stream: Writable): Promise<void> {
  let needDrain = false
  await new Promise((resolve, reject) => {
    needDrain = !stream.write(chunk, (err) => {
      if (err != null) {
        reject(err)
      } else {
        resolve(null)
      }
    })
  })
  if (needDrain) {
    await new Promise((resolve, reject) => stream.once('drain', resolve))
  }
}

async function writeChanges (storage: BackupStorage, snapshot: string, changes: Snapshot): Promise<void> {
  const snapshotWritable = await storage.write(snapshot)
  const writable = createGzip({ level: defaultLevel })
  writable.pipe(snapshotWritable)

  // Write size
  await write(`${changes.added.size}\n`, writable)
  for (const [k, v] of changes.added.entries()) {
    await write(`${k};${v}\n`, writable)
  }
  await write(`${changes.updated.size}\n`, writable)
  for (const [k, v] of changes.updated.entries()) {
    await write(`${k};${v}\n`, writable)
  }
  await write(`${changes.removed.length}\n`, writable)
  for (const k of changes.removed) {
    await write(`${k}\n`, writable)
  }
  writable.end()
  await new Promise((resolve) => {
    writable.flush(() => {
      resolve(null)
    })
  })
}

/**
 * @public
 */
export async function cloneWorkspace (
  ctx: MeasureContext,
  transactorUrl: string,
  sourceWorkspaceId: WorkspaceId,
  targetWorkspaceId: WorkspaceId,
  clearTime: boolean = true,
  progress: (value: number) => Promise<void>,
  storageAdapter: StorageAdapter
): Promise<void> {
  await ctx.with(
    'clone-workspace',
    {},
    async (ctx) => {
      const sourceConnection = await ctx.with(
        'connect-source',
        {},
        async (ctx) =>
          (await connect(transactorUrl, sourceWorkspaceId, undefined, {
            mode: 'backup'
          })) as unknown as CoreClient & BackupClient
      )
      const targetConnection = await ctx.with(
        'connect-target',
        {},
        async (ctx) =>
          (await connect(transactorUrl, targetWorkspaceId, undefined, {
            mode: 'backup',
            model: 'upgrade',
            admin: 'true'
          })) as unknown as CoreClient & BackupClient
      )
      try {
        const domains = sourceConnection
          .getHierarchy()
          .domains()
          .filter((it) => it !== DOMAIN_TRANSIENT && it !== DOMAIN_MODEL)

        let i = 0
        for (const c of domains) {
          ctx.info('clone domain...', { domain: c, workspace: targetWorkspaceId.name })

          // We need to clean target connection before copying something.
          await ctx.with('clean-domain', { domain: c }, async (ctx) => {
            await cleanDomain(ctx, targetConnection, c)
          })

          const changes: Snapshot = {
            added: new Map(),
            updated: new Map(),
            removed: []
          }

          let idx: number | undefined

          // update digest tar
          const needRetrieveChunks: Ref<Doc>[][] = []

          let processed = 0
          let domainProgress = 0
          let st = Date.now()
          // Load all digest from collection.
          await ctx.with('retrieve-domain-info', { domain: c }, async (ctx) => {
            while (true) {
              try {
                const it = await ctx.with('load-chunk', {}, async () => await sourceConnection.loadChunk(c, idx))
                idx = it.idx

                let needRetrieve: Ref<Doc>[] = []
                let needRetrieveSize = 0

                for (const { id, hash, size } of it.docs) {
                  processed++
                  if (Date.now() - st > 2500) {
                    ctx.info('processed', { processed, time: Date.now() - st, workspace: targetWorkspaceId.name })
                    st = Date.now()
                  }

                  changes.added.set(id as Ref<Doc>, hash)
                  needRetrieve.push(id as Ref<Doc>)
                  needRetrieveSize += size

                  if (needRetrieveSize > retrieveChunkSize) {
                    needRetrieveChunks.push(needRetrieve)
                    needRetrieveSize = 0
                    needRetrieve = []
                  }
                }
                if (needRetrieve.length > 0) {
                  needRetrieveChunks.push(needRetrieve)
                }
                if (it.finished) {
                  await ctx.with('close-chunk', {}, async () => {
                    await sourceConnection.closeChunk(idx as number)
                  })
                  break
                }
              } catch (err: any) {
                ctx.error('failed to clone', { err, workspace: targetWorkspaceId.name })
                if (idx !== undefined) {
                  await ctx.with('load-chunk', {}, async () => {
                    await sourceConnection.closeChunk(idx as number)
                  })
                }
                // Try again
                idx = undefined
                processed = 0
              }
            }
          })
          await ctx.with('clone-domain', { domain: c }, async (ctx) => {
            while (needRetrieveChunks.length > 0) {
              const needRetrieve = needRetrieveChunks.shift() as Ref<Doc>[]

              ctx.info('Retrieve chunk:', { count: needRetrieve.length })
              let docs: Doc[] = []
              try {
                docs = await ctx.with('load-docs', {}, async (ctx) => await sourceConnection.loadDocs(c, needRetrieve))
                if (clearTime) {
                  docs = prepareClonedDocuments(docs, sourceConnection)
                }
                const executor = new RateLimiter(10)
                for (const d of docs) {
                  if (d._class === core.class.Blob) {
                    const blob = d as Blob
                    await executor.exec(async () => {
                      try {
                        ctx.info('clone blob', { name: blob._id, contentType: blob.contentType })
                        const readable = await storageAdapter.get(ctx, sourceWorkspaceId, blob._id)
                        const passThrue = new PassThrough()
                        readable.pipe(passThrue)
                        await storageAdapter.put(
                          ctx,
                          targetWorkspaceId,
                          blob._id,
                          passThrue,
                          blob.contentType,
                          blob.size
                        )
                      } catch (err: any) {
                        Analytics.handleError(err)
                        console.error(err)
                      }
                      domainProgress++
                      await progress((100 / domains.length) * i + (100 / domains.length / processed) * domainProgress)
                    })
                  } else {
                    domainProgress++
                  }
                }
                await executor.waitProcessing()
                await ctx.with(
                  'upload-docs',
                  {},
                  async (ctx) => {
                    await targetConnection.upload(c, docs)
                  },
                  { length: docs.length }
                )
                await progress((100 / domains.length) * i + (100 / domains.length / processed) * domainProgress)
              } catch (err: any) {
                console.log(err)
                Analytics.handleError(err)
                // Put back.
                needRetrieveChunks.push(needRetrieve)
                continue
              }
            }
          })

          i++
          await progress((100 / domains.length) * i)
        }
      } catch (err: any) {
        console.error(err)
        Analytics.handleError(err)
      } finally {
        ctx.info('end clone')
        await ctx.with('close-source', {}, async (ctx) => {
          await sourceConnection.close()
        })
        await ctx.with('close-target', {}, async (ctx) => {
          await targetConnection.sendForceClose()
          await targetConnection.close()
        })
      }
    },
    {
      source: sourceWorkspaceId.name,
      target: targetWorkspaceId.name
    }
  )
}

function prepareClonedDocuments (docs: Doc[], sourceConnection: CoreClient & BackupClient): Doc[] {
  docs = docs.map((p) => {
    let collectionCud = false
    try {
      collectionCud = sourceConnection.getHierarchy().isDerived(p._class, core.class.TxCollectionCUD)
    } catch (err: any) {
      console.log(err)
    }

    // if full text is skipped, we need to clean stages for indexes.
    if (p._class === core.class.DocIndexState) {
      for (const k of Object.keys((p as DocIndexState).stages)) {
        if (k.startsWith(fullTextPushStagePrefix)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete (p as DocIndexState).stages[k]
        }
      }
    }

    if (collectionCud) {
      return {
        ...p,
        modifiedOn: Date.now(),
        createdOn: Date.now(),
        tx: {
          ...(p as TxCollectionCUD<Doc, AttachedDoc>).tx,
          modifiedOn: Date.now(),
          createdOn: Date.now()
        }
      }
    } else {
      return {
        ...p,
        modifiedOn: Date.now(),
        createdOn: Date.now()
      }
    }
  })
  return docs
}

async function cleanDomain (ctx: MeasureContext, connection: CoreClient & BackupClient, domain: Domain): Promise<void> {
  // Load all digest from collection.
  let idx: number | undefined
  const ids: Ref<Doc>[] = []
  while (true) {
    try {
      const it = await connection.loadChunk(domain, idx)
      idx = it.idx

      ids.push(...it.docs.map((it) => it.id as Ref<Doc>))
      if (it.finished) {
        break
      }
    } catch (err: any) {
      console.error(err)
      if (idx !== undefined) {
        await connection.closeChunk(idx)
      }
    }
  }
  while (ids.length > 0) {
    const part = ids.splice(0, 5000)
    await connection.clean(domain, part)
  }
}

/**
 * @public
 */
export async function backup (
  ctx: MeasureContext,
  transactorUrl: string,
  workspaceId: WorkspaceId,
  storage: BackupStorage,
  options: {
    include?: Set<string>
    skipDomains: string[]
    force: boolean
    recheck: boolean
    timeout: number
    connectTimeout: number
    skipBlobContentTypes: string[]
    blobDownloadLimit: number
    connection?: CoreClient & BackupClient
    storageAdapter?: StorageAdapter
  } = {
    force: false,
    recheck: false,
    timeout: 0,
    skipDomains: [],
    connectTimeout: 30000,
    skipBlobContentTypes: [],
    blobDownloadLimit: 15
  }
): Promise<void> {
  ctx = ctx.newChild('backup', {
    workspaceId: workspaceId.name,
    force: options.force,
    recheck: options.recheck,
    timeout: options.timeout
  })

  let canceled = false
  let timer: any

  if (options.timeout > 0) {
    timer = setTimeout(() => {
      ctx.error('Timeout during backup', { workspace: workspaceId.name, timeout: options.timeout / 1000 })
      canceled = true
    }, options.timeout)
  }

  const token = generateToken(systemAccountEmail, workspaceId, {
    mode: 'backup'
  })

  const connection =
    options.connection ??
    ((await createClient(transactorUrl, token, undefined, options.connectTimeout)) as CoreClient & BackupClient)

  const blobClient = new BlobClient(transactorUrl, token, workspaceId, { storageAdapter: options.storageAdapter })
  ctx.info('starting backup', { workspace: workspaceId.name })

  let tmpDir: string | undefined

  try {
    const domains = [
      ...connection
        .getHierarchy()
        .domains()
        .filter(
          (it) =>
            it !== DOMAIN_TRANSIENT &&
            it !== DOMAIN_MODEL &&
            it !== ('fulltext-blob' as Domain) &&
            !options.skipDomains.includes(it) &&
            (options.include === undefined || options.include.has(it))
        )
    ]
    ctx.info('domains for dump', { domains: domains.length })

    let backupInfo: BackupInfo = {
      workspace: workspaceId.name,
      version: '0.6.2',
      snapshots: []
    }

    // Version 0.6.2, format of digest file is changed to

    const infoFile = 'backup.json.gz'

    if (await storage.exists(infoFile)) {
      backupInfo = JSON.parse(gunzipSync(await storage.loadFile(infoFile)).toString())
    }
    backupInfo.version = '0.6.2'

    backupInfo.workspace = workspaceId.name

    // Skip backup if there is no transaction changes.
    const lastTx = await connection.findOne(
      core.class.Tx,
      {},
      { limit: 1, sort: { modifiedOn: SortingOrder.Descending } }
    )
    if (lastTx !== undefined) {
      if (lastTx._id === backupInfo.lastTxId && !options.force) {
        ctx.info('No transaction changes. Skipping backup.', { workspace: workspaceId.name })
        return
      }
    }

    backupInfo.lastTxId = '' // Clear until full backup will be complete

    const snapshot: BackupSnapshot = {
      date: Date.now(),
      domains: {}
    }

    backupInfo.snapshots.push(snapshot)
    let backupIndex = `${backupInfo.snapshotsIndex ?? backupInfo.snapshots.length}`
    while (backupIndex.length < 6) {
      backupIndex = '0' + backupIndex
    }

    let downloadedMb = 0
    let downloaded = 0

    const printDownloaded = (msg: string, size: number): void => {
      downloaded += size
      const newDownloadedMb = Math.round(downloaded / (1024 * 1024))
      const newId = Math.round(newDownloadedMb / 10)
      if (downloadedMb !== newId) {
        downloadedMb = newId
        ctx.info('Downloaded', {
          msg,
          written: newDownloadedMb
        })
      }
    }

    async function loadChangesFromServer (
      ctx: MeasureContext,
      domain: Domain,
      digest: Map<Ref<Doc>, string>,
      changes: Snapshot
    ): Promise<{ changed: number, needRetrieveChunks: Ref<Doc>[][] }> {
      let idx: number | undefined
      let processed = 0
      let st = Date.now()
      let changed: number = 0
      const needRetrieveChunks: Ref<Doc>[][] = []
      // Load all digest from collection.
      while (true) {
        try {
          const currentChunk = await ctx.with(
            'loadChunk',
            {},
            async () => await connection.loadChunk(domain, idx, options.recheck)
          )
          idx = currentChunk.idx

          let needRetrieve: Ref<Doc>[] = []
          let currentNeedRetrieveSize = 0

          for (const { id, hash, size } of currentChunk.docs) {
            processed++
            if (Date.now() - st > 2500) {
              ctx.info('processed', {
                processed,
                digest: digest.size,
                time: Date.now() - st,
                workspace: workspaceId.name
              })
              st = Date.now()
            }
            const kHash = digest.get(id as Ref<Doc>)
            if (kHash !== undefined) {
              digest.delete(id as Ref<Doc>)
              if (kHash !== hash) {
                changes.updated.set(id as Ref<Doc>, hash)
                needRetrieve.push(id as Ref<Doc>)
                currentNeedRetrieveSize += size
                changed++
              }
            } else {
              changes.added.set(id as Ref<Doc>, hash)
              needRetrieve.push(id as Ref<Doc>)
              changed++
              currentNeedRetrieveSize += size
            }

            if (currentNeedRetrieveSize > retrieveChunkSize) {
              needRetrieveChunks.push(needRetrieve)
              currentNeedRetrieveSize = 0
              needRetrieve = []
            }
          }
          if (needRetrieve.length > 0) {
            needRetrieveChunks.push(needRetrieve)
          }
          if (currentChunk.finished) {
            await ctx.with('closeChunk', {}, async () => {
              await connection.closeChunk(idx as number)
            })
            break
          }
        } catch (err: any) {
          console.error(err)
          ctx.error('failed to load chunks', { error: err })
          if (idx !== undefined) {
            await ctx.with('closeChunk', {}, async () => {
              await connection.closeChunk(idx as number)
            })
          }
          // Try again
          idx = undefined
          processed = 0
        }
      }
      return { changed, needRetrieveChunks }
    }

    async function processDomain (ctx: MeasureContext, domain: Domain): Promise<void> {
      const changes: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      const processedChanges: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      let stIndex = 0
      let snapshotIndex = 0
      const domainInfo: DomainData = {
        snapshot: undefined,
        snapshots: [],
        storage: [],
        added: 0,
        updated: 0,
        removed: 0
      }

      // Cumulative digest
      const digest = await ctx.with(
        'load-digest',
        {},
        async (ctx) => await loadDigest(ctx, storage, backupInfo.snapshots, domain)
      )

      let _pack: Pack | undefined
      let addedDocuments = 0

      let { changed, needRetrieveChunks } = await ctx.with(
        'load-chunks',
        { domain },
        async (ctx) => await loadChangesFromServer(ctx, domain, digest, changes)
      )

      if (needRetrieveChunks.length > 0) {
        ctx.info('dumping domain...', { workspace: workspaceId.name, domain })
      }

      while (needRetrieveChunks.length > 0) {
        if (canceled) {
          return
        }
        const needRetrieve = needRetrieveChunks.shift() as Ref<Doc>[]

        ctx.info('Retrieve chunk', {
          needRetrieve: needRetrieveChunks.reduce((v, docs) => v + docs.length, 0),
          toLoad: needRetrieve.length,
          workspace: workspaceId.name
        })
        let docs: Doc[] = []
        try {
          docs = await ctx.with('load-docs', {}, async (ctx) => await connection.loadDocs(domain, needRetrieve))
        } catch (err: any) {
          ctx.error('error loading docs', { domain, err, workspace: workspaceId.name })
          // Put back.
          needRetrieveChunks.push(needRetrieve)
          continue
        }

        while (docs.length > 0) {
          // Chunk data into small pieces
          if (addedDocuments > dataBlobSize && _pack !== undefined) {
            _pack.finalize()
            _pack = undefined
            addedDocuments = 0

            if (changed > 0) {
              snapshot.domains[domain] = domainInfo
              domainInfo.added += processedChanges.added.size
              domainInfo.updated += processedChanges.updated.size
              domainInfo.removed += processedChanges.removed.length

              const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${snapshotIndex}.snp.gz`)
              snapshotIndex++
              domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
              await writeChanges(storage, snapshotFile, processedChanges)

              processedChanges.added.clear()
              processedChanges.removed = []
              processedChanges.updated.clear()
              await storage.writeFile(
                infoFile,
                gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel })
              )
            }
          }
          if (_pack === undefined) {
            _pack = pack()
            stIndex++
            const storageFile = join(backupIndex, `${domain}-data-${snapshot.date}-${stIndex}.tar.gz`)
            ctx.info('storing from domain', { domain, storageFile, workspace: workspaceId.name })
            domainInfo.storage = [...(domainInfo.storage ?? []), storageFile]
            const dataStream = await storage.write(storageFile)
            const storageZip = createGzip({ level: defaultLevel, memLevel: 9 })

            _pack.pipe(storageZip)
            storageZip.pipe(dataStream)
          }
          if (canceled) {
            return
          }
          const d = docs.shift()
          if (d === undefined) {
            break
          }

          function processChanges (d: Doc, error: boolean = false): void {
            // Move processed document to processedChanges
            if (changes.added.has(d._id)) {
              if (!error) {
                processedChanges.added.set(d._id, changes.added.get(d._id) ?? '')
              }
              changes.added.delete(d._id)
            } else {
              if (!error) {
                processedChanges.updated.set(d._id, changes.updated.get(d._id) ?? '')
              }
              changes.updated.delete(d._id)
            }
          }
          if (d._class === core.class.Blob) {
            const blob = d as Blob
            const descrJson = JSON.stringify(d)

            if (blob.size > options.blobDownloadLimit * 1024 * 1024) {
              ctx.info('skip blob download, limit excheed', {
                blob: blob._id,
                provider: blob.provider,
                size: Math.round(blob.size / (1024 * 1024)),
                limit: options.blobDownloadLimit
              })
              processChanges(d, true)
              continue
            }

            if (
              options.skipBlobContentTypes.length > 0 &&
              options.skipBlobContentTypes.some((it) => blob.contentType.includes(it))
            ) {
              ctx.info('skip blob download, contentType', {
                blob: blob._id,
                provider: blob.provider,
                size: blob.size / (1024 * 1024)
              })
              processChanges(d, true)
              continue
            }

            let blobFiled = false
            addedDocuments += descrJson.length
            addedDocuments += blob.size

            printDownloaded(blob._id, descrJson.length)
            try {
              const buffers: Buffer[] = []
              await blobClient.writeTo(ctx, blob._id, blob.size, {
                write (buffer, cb) {
                  buffers.push(buffer)
                  cb()
                },
                end: (cb: () => void) => {
                  cb()
                }
              })

              const finalBuffer = Buffer.concat(buffers)
              if (finalBuffer.length !== blob.size) {
                tmpDir = tmpDir ?? (await mkdtemp('backup', {}))
                const tmpFile = join(tmpDir, blob._id)
                await writeFile(tmpFile, finalBuffer)
                await writeFile(tmpFile + '.json', JSON.stringify(blob, undefined, 2))
                ctx.error('download blob size mismatch', {
                  _id: blob._id,
                  contentType: blob.contentType,
                  size: blob.size,
                  provider: blob.provider,
                  tempDir: tmpDir
                })
              }
              _pack.entry({ name: d._id + '.json' }, descrJson, (err) => {
                if (err != null) throw err
              })
              _pack?.entry({ name: d._id, size: finalBuffer.length }, finalBuffer, (err) => {
                if (err != null) {
                  ctx.error('error packing file', { err })
                }
              })
              if (blob.size > 1024 * 1024) {
                ctx.info('download blob', {
                  _id: blob._id,
                  contentType: blob.contentType,
                  size: blob.size,
                  provider: blob.provider,
                  pending: docs.length
                })
              }

              printDownloaded(blob._id, blob.size)
            } catch (err: any) {
              if (err.message?.startsWith('No file for') === true) {
                ctx.error('failed to download blob', { message: err.message })
              } else {
                ctx.error('failed to download blob', { err })
              }
              blobFiled = true
            }

            processChanges(d, blobFiled)
          } else {
            const data = JSON.stringify(d)
            addedDocuments += data.length
            _pack.entry({ name: d._id + '.json' }, data, function (err) {
              if (err != null) throw err
            })
            processChanges(d)
            printDownloaded(d._id, data.length)
          }
        }
      }
      processedChanges.removed = Array.from(digest.keys())
      if (processedChanges.removed.length > 0) {
        changed++
      }

      if (changed > 0) {
        snapshot.domains[domain] = domainInfo
        domainInfo.added += processedChanges.added.size
        domainInfo.updated += processedChanges.updated.size
        domainInfo.removed += processedChanges.removed.length

        const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${snapshotIndex}.snp.gz`)
        snapshotIndex++
        domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
        await writeChanges(storage, snapshotFile, processedChanges)

        processedChanges.added.clear()
        processedChanges.removed = []
        processedChanges.updated.clear()
        _pack?.finalize()
        // This will allow to retry in case of critical error.
        await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
      }
    }

    for (const domain of domains) {
      if (canceled) {
        break
      }
      await ctx.with('process-domain', { domain }, async (ctx) => {
        await processDomain(ctx, domain)
      })
    }
    if (!canceled) {
      backupInfo.snapshotsIndex = backupInfo.snapshots.length
      backupInfo.lastTxId = lastTx?._id ?? '0' // We could store last tx, since full backup is complete
      await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
    }
  } catch (err: any) {
    ctx.error('backup error', { err, workspace: workspaceId.name })
  } finally {
    ctx.info('end backup', { workspace: workspaceId.name })
    if (options.connection === undefined) {
      await connection.close()
    }
    ctx.end()
    if (options.timeout !== -1) {
      clearTimeout(timer)
    }
  }
}

/**
 * @public
 */
export async function backupList (storage: BackupStorage): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(await storage.loadFile(infoFile)).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)
  for (const s of backupInfo.snapshots) {
    console.log('snapshot: id:', s.date, ' date:', new Date(s.date))
  }
}

/**
 * @public
 */
export async function backupFind (storage: BackupStorage, id: Ref<Doc>, domain?: string): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(await storage.loadFile(infoFile)).toString())
  console.log('workspace:', backupInfo.workspace ?? '', backupInfo.version)

  const toolCtx = new MeasureMetricsContext('', {})

  const snapshots = backupInfo.snapshots
  const rnapshots = Array.from(backupInfo.snapshots).reverse()

  // Collect all possible domains
  const domains = new Set<Domain>()
  for (const s of snapshots) {
    Object.keys(s.domains).forEach((it) => domains.add(it as Domain))
  }

  for (const dd of domains) {
    if (domain !== undefined && dd !== domain) {
      continue
    }
    console.log('checking:', dd)
    const sDigest = await loadDigest(toolCtx, storage, snapshots, dd)
    if (sDigest.has(id)) {
      console.log('we found file')
      let found = false
      for (const sn of rnapshots) {
        const d = sn.domains[dd]
        if (found) {
          break
        }
        for (const sf of d?.storage ?? []) {
          if (found) {
            break
          }
          console.log('processing', sf)
          const readStream = await storage.load(sf)
          const ex = extract()

          ex.on('entry', (headers, stream, next) => {
            if (headers.name === id + '.json') {
              console.log('file found in:', sf)
              found = true
            }
            next()
            stream.resume() // just auto drain the stream
          })

          const endPromise = new Promise((resolve) => {
            ex.on('finish', () => {
              resolve(null)
            })
          })
          const unzip = createGunzip({ level: defaultLevel })

          readStream.on('end', () => {
            readStream.destroy()
          })
          readStream.pipe(unzip)
          unzip.pipe(ex)

          await endPromise
        }
      }
    }
  }
}

/**
 * @public
 * Restore state of DB to specified point.
 */
export async function restore (
  ctx: MeasureContext,
  transactorUrl: string,
  workspaceId: WorkspaceId,
  storage: BackupStorage,
  opt: {
    date: number
    merge?: boolean
    parallel?: number
    recheck?: boolean
    include?: Set<string>
    skip?: Set<string>
  }
): Promise<void> {
  const infoFile = 'backup.json.gz'

  if (!(await storage.exists(infoFile))) {
    ctx.error('file not pressent', { file: infoFile })
    throw new Error(`${infoFile} should present to restore`)
  }
  const backupInfo: BackupInfo = JSON.parse(gunzipSync(await storage.loadFile(infoFile)).toString())
  let snapshots = backupInfo.snapshots
  if (opt.date !== -1) {
    const bk = backupInfo.snapshots.findIndex((it) => it.date === opt.date)
    if (bk === -1) {
      ctx.error('could not restore to', { date: opt.date, file: infoFile, workspaceId: workspaceId.name })
      throw new Error(`${infoFile} could not restore to ${opt.date}. Snapshot is missing.`)
    }
    snapshots = backupInfo.snapshots.slice(0, bk + 1)
  } else {
    opt.date = snapshots[snapshots.length - 1].date
  }
  ctx.info('restore to ', { id: opt.date, date: new Date(opt.date).toDateString() })
  const rsnapshots = Array.from(snapshots).reverse()

  // Collect all possible domains
  const domains = new Set<Domain>()
  for (const s of snapshots) {
    Object.keys(s.domains).forEach((it) => domains.add(it as Domain))
  }

  ctx.info('connecting:', { transactorUrl, workspace: workspaceId.name })

  const token = generateToken(systemAccountEmail, workspaceId, {
    mode: 'backup',
    model: 'upgrade'
  })

  const connection = (await createClient(transactorUrl, token)) as CoreClient & BackupClient

  const blobClient = new BlobClient(transactorUrl, token, workspaceId)
  console.log('connected')

  // We need to find empty domains and clean them.
  const allDomains = connection.getHierarchy().domains()
  for (const d of allDomains) {
    domains.add(d)
  }

  // We do not backup elastic anymore
  domains.delete('fulltext-blob' as Domain)

  let uploadedMb = 0
  let uploaded = 0

  const printUploaded = (msg: string, size: number): void => {
    uploaded += size
    const newDownloadedMb = Math.round(uploaded / (1024 * 1024))
    const newId = Math.round(newDownloadedMb / 10)
    if (uploadedMb !== newId) {
      uploadedMb = newId
      ctx.info('Uploaded', {
        msg,
        written: newDownloadedMb,
        workspace: workspaceId.name
      })
    }
  }

  async function processDomain (c: Domain): Promise<void> {
    const changeset = await loadDigest(ctx, storage, snapshots, c, opt.date)
    // We need to load full changeset from server
    const serverChangeset = new Map<Ref<Doc>, string>()

    let idx: number | undefined
    let loaded = 0
    let el = 0
    let chunks = 0
    try {
      while (true) {
        const st = Date.now()
        const it = await connection.loadChunk(c, idx, opt.recheck)
        chunks++

        idx = it.idx
        el += Date.now() - st

        for (const { id, hash } of it.docs) {
          serverChangeset.set(id as Ref<Doc>, hash)
          loaded++
        }

        if (el > 2500) {
          ctx.info('loaded from server', { domain: c, loaded, el, chunks, workspace: workspaceId.name })
          el = 0
          chunks = 0
        }
        if (it.finished) {
          break
        }
      }
    } finally {
      if (idx !== undefined) {
        await connection.closeChunk(idx)
      }
    }
    ctx.info('loaded', { loaded, workspace: workspaceId.name })
    ctx.info('\tcompare documents', {
      size: changeset.size,
      serverSize: serverChangeset.size,
      workspace: workspaceId.name
    })

    // Let's find difference
    const docsToAdd = new Map(
      Array.from(changeset.entries()).filter(
        ([it]) => !serverChangeset.has(it) || (serverChangeset.has(it) && serverChangeset.get(it) !== changeset.get(it))
      )
    )
    const docsToRemove = Array.from(serverChangeset.keys()).filter((it) => !changeset.has(it))

    const docs: Doc[] = []
    const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()
    let sendSize = 0
    let totalSend = 0
    async function sendChunk (doc: Doc | undefined, len: number): Promise<void> {
      if (doc !== undefined) {
        docsToAdd.delete(doc._id)
        if (opt.recheck === true) {
          // We need to clear %hash% in case our is wrong.
          delete (doc as any)['%hash%']
        }
        docs.push(doc)
      }
      sendSize = sendSize + len

      if (sendSize > dataUploadSize || (doc === undefined && docs.length > 0)) {
        totalSend += docs.length
        ctx.info('upload', {
          docs: docs.length,
          totalSend,
          from: docsToAdd.size + totalSend,
          sendSize,
          workspace: workspaceId.name
        })
        await connection.upload(c, docs)
        docs.length = 0
        sendSize = 0
      }
      printUploaded('upload', len)
    }
    let processed = 0

    for (const s of rsnapshots) {
      const d = s.domains[c]

      if (d !== undefined && docsToAdd.size > 0) {
        const sDigest = await loadDigest(ctx, storage, [s], c)
        const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => docsToAdd.has(it)))
        if (requiredDocs.size > 0) {
          ctx.info('updating', { domain: c, requiredDocs: requiredDocs.size, workspace: workspaceId.name })
          // We have required documents here.
          for (const sf of d.storage ?? []) {
            if (docsToAdd.size === 0) {
              break
            }
            ctx.info('processing', { storageFile: sf, processed, workspace: workspaceId.name })

            const readStream = await storage.load(sf)
            const ex = extract()

            ex.on('entry', (headers, stream, next) => {
              const name = headers.name ?? ''
              processed++
              // We found blob data
              if (requiredDocs.has(name as Ref<Doc>)) {
                const chunks: Buffer[] = []
                stream.on('data', (chunk) => {
                  chunks.push(chunk)
                })
                stream.on('end', () => {
                  const bf = Buffer.concat(chunks)
                  const d = blobs.get(name)
                  if (d === undefined) {
                    blobs.set(name, { doc: undefined, buffer: bf })
                    next()
                  } else {
                    blobs.delete(name)
                    const doc = d?.doc as Blob
                    ;(doc as any)['%hash%'] = changeset.get(doc._id)
                    void blobClient.upload(ctx, doc._id, doc.size, doc.contentType, bf).then(() => {
                      void sendChunk(doc, bf.length).finally(() => {
                        requiredDocs.delete(doc._id)
                        printUploaded('upload', bf.length)
                        next()
                      })
                    })
                  }
                })
              } else if (name.endsWith('.json') && requiredDocs.has(name.substring(0, name.length - 5) as Ref<Doc>)) {
                const chunks: Buffer[] = []
                const bname = name.substring(0, name.length - 5)
                stream.on('data', (chunk) => {
                  chunks.push(chunk)
                })
                stream.on('end', () => {
                  const bf = Buffer.concat(chunks)
                  const doc = JSON.parse(bf.toString()) as Doc
                  if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                    const data = migradeBlobData(doc as Blob, changeset.get(doc._id) as string)
                    const d = blobs.get(bname) ?? (data !== '' ? Buffer.from(data, 'base64') : undefined)
                    if (d === undefined) {
                      blobs.set(bname, { doc, buffer: undefined })
                      next()
                    } else {
                      blobs.delete(bname)
                      const blob = doc as Blob
                      void blobClient
                        .upload(
                          ctx,
                          blob._id,
                          blob.size,
                          blob.contentType,
                          d instanceof Buffer ? d : (d.buffer as Buffer)
                        )
                        .then(() => {
                          ;(doc as any)['%hash%'] = changeset.get(doc._id)
                          void sendChunk(doc, bf.length).finally(() => {
                            requiredDocs.delete(doc._id)
                            next()
                            printUploaded('upload', bf.length)
                          })
                        })
                    }
                  } else {
                    ;(doc as any)['%hash%'] = changeset.get(doc._id)
                    void sendChunk(doc, bf.length).finally(() => {
                      requiredDocs.delete(doc._id)
                      next()
                    })
                  }
                })
              } else {
                next()
              }
              stream.resume() // just auto drain the stream
            })

            const endPromise = new Promise((resolve) => {
              ex.on('finish', () => {
                resolve(null)
              })
            })
            const unzip = createGunzip({ level: defaultLevel })

            readStream.on('end', () => {
              readStream.destroy()
            })
            readStream.pipe(unzip)
            unzip.pipe(ex)

            await endPromise
          }
        }
      }
    }

    await sendChunk(undefined, 0)
    async function performCleanOfDomain (docsToRemove: Ref<Doc>[], c: Domain): Promise<void> {
      ctx.info('cleanup', { toRemove: docsToRemove.length, workspace: workspaceId.name, domain: c })
      while (docsToRemove.length > 0) {
        const part = docsToRemove.splice(0, 10000)
        try {
          await connection.clean(c, part)
        } catch (err: any) {
          ctx.error('failed to clean, will retry', { error: err, workspaceId: workspaceId.name })
          docsToRemove.push(...part)
        }
      }
    }
    if (c !== DOMAIN_BLOB) {
      // Clean domain documents if not blob
      if (docsToRemove.length > 0 && opt.merge !== true) {
        if (c === DOMAIN_DOC_INDEX_STATE) {
          // We need o clean a FULLTEXT domain as well
          await performCleanOfDomain([...docsToRemove], DOMAIN_FULLTEXT_BLOB)
        }

        await performCleanOfDomain(docsToRemove, c)
      }
    }
  }

  const limiter = new RateLimiter(opt.parallel ?? 1)

  try {
    for (const c of domains) {
      if (opt.include !== undefined && !opt.include.has(c)) {
        continue
      }
      if (opt.skip?.has(c) === true) {
        continue
      }
      await limiter.exec(async () => {
        ctx.info('processing domain', { domain: c, workspaceId: workspaceId.name })
        let retry = 5
        let delay = 1
        while (retry > 0) {
          retry--
          try {
            await processDomain(c)
            if (delay > 1) {
              ctx.warn('retry-success', { retry, delay, workspaceId: workspaceId.name })
            }
            break
          } catch (err: any) {
            ctx.error('failed to process domain', { err, domain: c, workspaceId: workspaceId.name })
            if (retry !== 0) {
              ctx.warn('cool-down to retry', { delay, domain: c, workspaceId: workspaceId.name })
              await new Promise((resolve) => setTimeout(resolve, delay * 1000))
              delay++
            }
          }
        }
      })
    }
    await limiter.waitProcessing()
  } finally {
    await connection.sendForceClose()
    await connection.close()
  }
}

/**
 * Compacting backup into just one snapshot.
 * @public
 */
export async function compactBackup (
  ctx: MeasureContext,
  storage: BackupStorage,
  force: boolean = false
): Promise<void> {
  console.log('starting backup compaction')
  try {
    let backupInfo: BackupInfo

    // Version 0.6.2, format of digest file is changed to

    const infoFile = 'backup.json.gz'

    if (await storage.exists(infoFile)) {
      backupInfo = JSON.parse(gunzipSync(await storage.loadFile(infoFile)).toString())
    } else {
      console.log('No backup found')
      return
    }
    if (backupInfo.version !== '0.6.2') {
      console.log('Invalid backup version')
      return
    }

    if (backupInfo.snapshots.length < 5 && !force) {
      console.log('No need to compact, less 5 snapshots')
      return
    }

    const snapshot: BackupSnapshot = {
      date: Date.now(),
      domains: {}
    }

    const oldSnapshots = [...backupInfo.snapshots]

    backupInfo.snapshots = [snapshot]
    let backupIndex = `${backupInfo.snapshotsIndex ?? oldSnapshots.length}`
    while (backupIndex.length < 6) {
      backupIndex = '0' + backupIndex
    }

    const domains: Domain[] = []
    for (const sn of oldSnapshots) {
      for (const d of Object.keys(sn.domains)) {
        if (!domains.includes(d as Domain)) {
          domains.push(d as Domain)
        }
      }
    }

    for (const domain of domains) {
      console.log('compacting domain...', domain)

      const processedChanges: Snapshot = {
        added: new Map(),
        updated: new Map(),
        removed: []
      }

      let changed = 0
      let stIndex = 0
      let snapshotIndex = 0
      const domainInfo: DomainData = {
        snapshot: undefined,
        snapshots: [],
        storage: [],
        added: 0,
        updated: 0,
        removed: 0
      }

      // Cumulative digest
      const digest = await loadDigest(ctx, storage, oldSnapshots, domain)
      const digestAdded = new Map<Ref<Doc>, string>()

      const rsnapshots = Array.from(oldSnapshots).reverse()

      let _pack: Pack | undefined
      let addedDocuments = 0

      let processed = 0

      const blobs = new Map<string, { doc: Doc | undefined, buffer: Buffer | undefined }>()

      async function pushDocs (docs: Doc[], size: number, blobData: Record<Ref<Doc>, Buffer>): Promise<void> {
        addedDocuments += size
        changed += docs.length
        // Chunk data into small pieces
        if (addedDocuments > dataBlobSize && _pack !== undefined) {
          _pack.finalize()
          _pack = undefined
          addedDocuments = 0

          if (changed > 0) {
            snapshot.domains[domain] = domainInfo
            domainInfo.added += processedChanges.added.size
            domainInfo.updated += processedChanges.updated.size
            domainInfo.removed += processedChanges.removed.length

            const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${snapshotIndex}.snp.gz`)
            snapshotIndex++
            domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
            await writeChanges(storage, snapshotFile, processedChanges)

            processedChanges.added.clear()
            processedChanges.removed = []
            processedChanges.updated.clear()
            await storage.writeFile(
              infoFile,
              gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel })
            )
          }
        }
        if (_pack === undefined) {
          _pack = pack()
          stIndex++
          const storageFile = join(backupIndex, `${domain}-data-${snapshot.date}-${stIndex}.tar.gz`)
          console.log('storing from domain', domain, storageFile)
          domainInfo.storage = [...(domainInfo.storage ?? []), storageFile]
          const dataStream = await storage.write(storageFile)
          const storageZip = createGzip({ level: defaultLevel })

          _pack.pipe(storageZip)
          storageZip.pipe(dataStream)
        }

        while (docs.length > 0) {
          const d = docs.shift()
          if (d === undefined) {
            break
          }

          // Move processed document to processedChanges
          processedChanges.added.set(d._id, digestAdded.get(d._id) ?? '')

          if (d._class === core.class.Blob || d._class === 'core:class:BlobData') {
            const blob = d as Blob | BlobData

            const data = blobData[blob._id]
            const descrJson = JSON.stringify(d)
            addedDocuments += descrJson.length
            addedDocuments += data.length
            _pack.entry({ name: d._id + '.json' }, descrJson, function (err) {
              if (err != null) throw err
            })
            _pack.entry({ name: d._id }, data, function (err) {
              if (err != null) throw err
            })
          } else {
            const data = JSON.stringify(d)
            addedDocuments += data.length
            _pack.entry({ name: d._id + '.json' }, data, function (err) {
              if (err != null) throw err
            })
          }
        }
      }
      async function sendChunk (doc: Doc | undefined, len: number, blobData: Record<Ref<Doc>, Buffer>): Promise<void> {
        if (doc !== undefined) {
          const hash = digest.get(doc._id)
          digest.delete(doc._id)
          digestAdded.set(doc._id, hash ?? '')
          await pushDocs([doc], len, blobData)
        }
      }

      for (const s of rsnapshots) {
        const d = s.domains[domain]

        if (d !== undefined && digest.size > 0) {
          const sDigest = await loadDigest(ctx, storage, [s], domain)
          const requiredDocs = new Map(Array.from(sDigest.entries()).filter(([it]) => digest.has(it)))
          if (requiredDocs.size > 0) {
            console.log('updating', domain, requiredDocs.size)
            // We have required documents here.
            for (const sf of d.storage ?? []) {
              if (digest.size === 0) {
                break
              }
              console.log('processing', sf, processed)

              const readStream = await storage.load(sf)
              const ex = extract()

              ex.on('entry', (headers, stream, next) => {
                const name = headers.name ?? ''
                processed++
                // We found blob data
                if (requiredDocs.has(name as Ref<Doc>)) {
                  const chunks: Buffer[] = []
                  stream.on('data', (chunk) => {
                    chunks.push(chunk)
                  })
                  stream.on('end', () => {
                    const bf = Buffer.concat(chunks)
                    const d = blobs.get(name)
                    if (d === undefined) {
                      blobs.set(name, { doc: undefined, buffer: bf })
                      next()
                    } else {
                      const d = blobs.get(name)
                      blobs.delete(name)
                      const doc = d?.doc as Blob
                      void sendChunk(doc, bf.length, { [doc._id]: bf }).finally(() => {
                        requiredDocs.delete(doc._id)
                        next()
                      })
                    }
                  })
                } else if (name.endsWith('.json') && requiredDocs.has(name.substring(0, name.length - 5) as Ref<Doc>)) {
                  const chunks: Buffer[] = []
                  const bname = name.substring(0, name.length - 5)
                  stream.on('data', (chunk) => {
                    chunks.push(chunk)
                  })
                  stream.on('end', () => {
                    const bf = Buffer.concat(chunks)
                    const doc = JSON.parse(bf.toString()) as Doc
                    if (doc._class === core.class.Blob || doc._class === 'core:class:BlobData') {
                      const d = blobs.get(bname)
                      if (d === undefined) {
                        blobs.set(bname, { doc, buffer: undefined })
                        next()
                      } else {
                        blobs.delete(bname)
                        ;(doc as any)['%hash%'] = digest.get(doc._id)
                        void sendChunk(doc, bf.length, { [doc._id]: d?.buffer as Buffer }).finally(() => {
                          requiredDocs.delete(doc._id)
                          next()
                        })
                      }
                    } else {
                      ;(doc as any)['%hash%'] = digest.get(doc._id)
                      void sendChunk(doc, bf.length, {}).finally(() => {
                        requiredDocs.delete(doc._id)
                        next()
                      })
                    }
                  })
                } else {
                  next()
                }
                stream.resume() // just auto drain the stream
              })

              const endPromise = new Promise((resolve) => {
                ex.on('finish', () => {
                  resolve(null)
                })
              })
              const unzip = createGunzip({ level: defaultLevel })

              readStream.on('end', () => {
                readStream.destroy()
              })
              readStream.pipe(unzip)
              unzip.pipe(ex)

              await endPromise
            }
          } else {
            console.log('domain had no changes', domain)
          }
        }
      }

      if (changed > 0) {
        snapshot.domains[domain] = domainInfo
        domainInfo.added += processedChanges.added.size
        domainInfo.updated += processedChanges.updated.size
        domainInfo.removed += processedChanges.removed.length

        const snapshotFile = join(backupIndex, `${domain}-${snapshot.date}-${snapshotIndex}.snp.gz`)
        snapshotIndex++
        domainInfo.snapshots = [...(domainInfo.snapshots ?? []), snapshotFile]
        await writeChanges(storage, snapshotFile, processedChanges)

        processedChanges.added.clear()
        processedChanges.removed = []
        processedChanges.updated.clear()
        _pack?.finalize()
        // This will allow to retry in case of critical error.
        await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
      }
    }

    // We could get rid of all old snapshot files.
    for (const s of oldSnapshots) {
      for (const [, dta] of Object.entries(s.domains)) {
        for (const sf of dta.storage ?? []) {
          console.log('removing', sf)
          await storage.delete(sf)
        }
        for (const sf of dta.snapshots ?? []) {
          console.log('removing', sf)
          await storage.delete(sf)
        }
        if (dta.snapshot !== undefined) {
          await storage.delete(dta.snapshot)
        }
      }
    }

    backupInfo.snapshotsIndex = backupInfo.snapshots.length
    await storage.writeFile(infoFile, gzipSync(JSON.stringify(backupInfo, undefined, 2), { level: defaultLevel }))
  } catch (err: any) {
    console.error(err)
  } finally {
    console.log('end compacting')
  }
}

export * from './service'
function migradeBlobData (blob: Blob, etag: string): string {
  if (blob._class === 'core:class:BlobData') {
    const bd = blob as unknown as BlobData
    blob.contentType = blob.contentType ?? bd.type
    blob.storageId = bd._id
    blob.etag = etag
    blob._class = core.class.Blob
    delete (blob as any).type
    const result = (blob as any).base64Data
    delete (blob as any).base64Data
    return result
  }
  return ''
}
