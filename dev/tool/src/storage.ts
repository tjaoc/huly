//
// Copyright © 2024 Hardcore Engineering Inc.
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

import { type Attachment } from '@hcengineering/attachment'
import { type Blob, type MeasureContext, type Ref, type WorkspaceId, RateLimiter } from '@hcengineering/core'
import { DOMAIN_ATTACHMENT } from '@hcengineering/model-attachment'
import { type ListBlobResult, type StorageAdapter, type StorageAdapterEx } from '@hcengineering/server-core'
import { type Db } from 'mongodb'
import { PassThrough } from 'stream'

export interface MoveFilesParams {
  concurrency: number
  move: boolean
}

export async function syncFiles (
  ctx: MeasureContext,
  workspaceId: WorkspaceId,
  exAdapter: StorageAdapterEx
): Promise<void> {
  if (exAdapter.adapters === undefined) return

  for (const [name, adapter] of [...exAdapter.adapters.entries()].reverse()) {
    await adapter.make(ctx, workspaceId)

    await retryOnFailure(ctx, 5, async () => {
      let time = Date.now()
      let count = 0

      const iterator = await adapter.listStream(ctx, workspaceId)
      try {
        while (true) {
          const dataBulk = await iterator.next()
          if (dataBulk.length === 0) break

          for (const data of dataBulk) {
            const blob = await exAdapter.stat(ctx, workspaceId, data._id)
            if (blob !== undefined) {
              if (blob.provider !== name && name === exAdapter.defaultAdapter) {
                await exAdapter.syncBlobFromStorage(ctx, workspaceId, data._id, exAdapter.defaultAdapter)
              }
              continue
            }

            await exAdapter.syncBlobFromStorage(ctx, workspaceId, data._id, name)

            count += 1
            if (count % 100 === 0) {
              const duration = Date.now() - time
              time = Date.now()

              console.log('...processed', count, Math.round(duration / 1000) + 's')
            }
          }
        }
        console.log('processed', count)
      } finally {
        await iterator.close()
      }
    })
  }
}

export async function moveFiles (
  ctx: MeasureContext,
  workspaceId: WorkspaceId,
  exAdapter: StorageAdapterEx,
  params: MoveFilesParams
): Promise<void> {
  if (exAdapter.adapters === undefined) return

  const target = exAdapter.adapters.get(exAdapter.defaultAdapter)
  if (target === undefined) return

  // We assume that the adapter moves all new files to the default adapter
  await target.make(ctx, workspaceId)

  for (const [name, adapter] of exAdapter.adapters.entries()) {
    if (name === exAdapter.defaultAdapter) continue

    console.log('moving from', name, 'limit', 'concurrency', params.concurrency)

    // we attempt retry the whole process in case of failure
    // files that were already moved will be skipped
    await retryOnFailure(ctx, 5, async () => {
      await processAdapter(ctx, exAdapter, adapter, target, workspaceId, params)
    })
  }
}

export async function showLostFiles (
  ctx: MeasureContext,
  workspaceId: WorkspaceId,
  db: Db,
  storageAdapter: StorageAdapter,
  { showAll }: { showAll: boolean }
): Promise<void> {
  const iterator = db.collection<Attachment>(DOMAIN_ATTACHMENT).find({})

  while (true) {
    const attachment = await iterator.next()
    if (attachment === null) break

    const { _id, _class, file, name, modifiedOn } = attachment
    const date = new Date(modifiedOn).toISOString()

    const stat = await storageAdapter.stat(ctx, workspaceId, file)
    if (stat === undefined) {
      console.warn('-', date, _class, _id, file, name)
    } else if (showAll) {
      console.log('+', date, _class, _id, file, name)
    }
  }
}

async function processAdapter (
  ctx: MeasureContext,
  exAdapter: StorageAdapterEx,
  source: StorageAdapter,
  target: StorageAdapter,
  workspaceId: WorkspaceId,
  params: MoveFilesParams
): Promise<void> {
  if (source === target) {
    // Just in case
    return
  }
  let time = Date.now()
  let processedCnt = 0
  let processedBytes = 0
  let movedCnt = 0
  let movedBytes = 0
  let batchBytes = 0

  function printStats (): void {
    const duration = Date.now() - time
    console.log(
      '...processed',
      processedCnt,
      Math.round(processedBytes / 1024 / 1024) + 'MB',
      'moved',
      movedCnt,
      Math.round(movedBytes / 1024 / 1024) + 'MB',
      '+' + Math.round(batchBytes / 1024 / 1024) + 'MB',
      Math.round(duration / 1000) + 's'
    )

    batchBytes = 0
    time = Date.now()
  }

  const rateLimiter = new RateLimiter(params.concurrency)

  const iterator = await source.listStream(ctx, workspaceId)

  const targetIterator = await target.listStream(ctx, workspaceId)

  const targetBlobs = new Map<Ref<Blob>, ListBlobResult>()

  let targetFilled = false

  const toRemove: string[] = []
  try {
    while (true) {
      const dataBulk = await iterator.next()
      if (dataBulk.length === 0) break

      if (!targetFilled) {
        // Only fill target if have something to move.
        targetFilled = true
        while (true) {
          const part = await targetIterator.next()
          for (const p of part) {
            targetBlobs.set(p._id, p)
          }
          if (part.length === 0) {
            break
          }
        }
      }

      for (const data of dataBulk) {
        let targetBlob: Blob | ListBlobResult | undefined = targetBlobs.get(data._id)
        if (targetBlob !== undefined) {
          console.log('Target blob already exists', targetBlob._id)

          const aggrBlob = await exAdapter.stat(ctx, workspaceId, data._id)
          if (aggrBlob === undefined || aggrBlob?.provider !== targetBlob.provider) {
            targetBlob = await exAdapter.syncBlobFromStorage(ctx, workspaceId, targetBlob._id, exAdapter.defaultAdapter)
          }
          // We could safely delete source blob
          toRemove.push(data._id)
        }

        if (targetBlob === undefined) {
          const sourceBlob = await source.stat(ctx, workspaceId, data._id)

          if (sourceBlob === undefined) {
            console.error('blob not found', data._id)
            continue
          }
          targetBlob = await rateLimiter.exec(async () => {
            try {
              const result = await retryOnFailure(
                ctx,
                5,
                async () => {
                  await processFile(ctx, source, target, workspaceId, sourceBlob)
                  // We need to sync and update aggregator table for now.
                  return await exAdapter.syncBlobFromStorage(ctx, workspaceId, sourceBlob._id, exAdapter.defaultAdapter)
                },
                50
              )
              movedCnt += 1
              movedBytes += sourceBlob.size
              batchBytes += sourceBlob.size
              return result
            } catch (err) {
              console.error('failed to process blob', data._id, err)
            }
          })

          if (targetBlob !== undefined) {
            // We could safely delete source blob
            toRemove.push(sourceBlob._id)
          }
          processedBytes += sourceBlob.size
        }
        processedCnt += 1

        if (processedCnt % 100 === 0) {
          await rateLimiter.waitProcessing()
          printStats()
        }
      }
    }

    await rateLimiter.waitProcessing()
    if (toRemove.length > 0 && params.move) {
      while (toRemove.length > 0) {
        const part = toRemove.splice(0, 500)
        await source.remove(ctx, workspaceId, part)
      }
    }
    printStats()
  } finally {
    await iterator.close()
  }
}

async function processFile (
  ctx: MeasureContext,
  source: Pick<StorageAdapter, 'get'>,
  target: Pick<StorageAdapter, 'put'>,
  workspaceId: WorkspaceId,
  blob: Blob
): Promise<void> {
  const readable = await source.get(ctx, workspaceId, blob._id)
  try {
    readable.on('end', () => {
      readable.destroy()
    })
    const stream = readable.pipe(new PassThrough())
    await target.put(ctx, workspaceId, blob._id, stream, blob.contentType, blob.size)
  } finally {
    readable.destroy()
  }
}

async function retryOnFailure<T> (
  ctx: MeasureContext,
  retries: number,
  op: () => Promise<T>,
  delay: number = 0
): Promise<T> {
  let lastError: any
  while (retries > 0) {
    retries--
    try {
      return await op()
    } catch (err: any) {
      console.error(err)
      lastError = err
      ctx.error('error', { err, retries })
      if (retries !== 0 && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  throw lastError
}
