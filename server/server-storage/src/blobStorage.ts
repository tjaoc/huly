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

import core, {
  Class,
  Doc,
  DocumentQuery,
  DocumentUpdate,
  Domain,
  FindOptions,
  FindResult,
  Hierarchy,
  IndexingConfiguration,
  MeasureContext,
  ModelDb,
  Ref,
  StorageIterator,
  Tx,
  TxResult,
  WorkspaceId,
  type Blob
} from '@hcengineering/core'
import { createMongoAdapter } from '@hcengineering/mongo'
import { PlatformError, unknownError } from '@hcengineering/platform'
import {
  DbAdapter,
  StorageAdapter,
  type DomainHelperOperations,
  type StorageAdapterEx
} from '@hcengineering/server-core'

class StorageBlobAdapter implements DbAdapter {
  constructor (
    readonly workspaceId: WorkspaceId,
    readonly client: StorageAdapter, // Should not be closed
    readonly ctx: MeasureContext,
    readonly blobAdapter: DbAdapter // A real blob adapter for Blob documents.
  ) {}

  async findAll<T extends Doc>(
    ctx: MeasureContext,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    return await this.blobAdapter.findAll(ctx, _class, query, options)
  }

  helper (): DomainHelperOperations {
    return this.blobAdapter.helper()
  }

  async groupBy<T>(ctx: MeasureContext, domain: Domain, field: string): Promise<Set<T>> {
    return await this.blobAdapter.groupBy(ctx, domain, field)
  }

  async tx (ctx: MeasureContext, ...tx: Tx[]): Promise<TxResult[]> {
    throw new PlatformError(unknownError('Direct Blob operations are not possible'))
  }

  async createIndexes (domain: Domain, config: Pick<IndexingConfiguration<Doc>, 'indexes'>): Promise<void> {}
  async removeOldIndex (domain: Domain, deletePattern: RegExp[], keepPattern: RegExp[]): Promise<void> {}

  async close (): Promise<void> {
    await this.blobAdapter.close()
  }

  find (ctx: MeasureContext, domain: Domain, recheck?: boolean): StorageIterator {
    return (this.client as StorageAdapterEx).find(ctx, this.workspaceId)
  }

  async load (ctx: MeasureContext, domain: Domain, docs: Ref<Doc>[]): Promise<Doc[]> {
    return await this.blobAdapter.load(ctx, domain, docs)
  }

  async upload (ctx: MeasureContext, domain: Domain, docs: Doc[]): Promise<void> {
    // We need to update docs to have provider === defualt one.
    if ('adapters' in this.client) {
      const toUpload: Doc[] = []
      const adapterEx = this.client as StorageAdapterEx
      for (const d of docs) {
        // We need sync stats to be sure all info are correct from storage.
        if (d._class === core.class.Blob) {
          const blob = d as Blob
          const blobStat = await this.client.stat(ctx, this.workspaceId, blob.storageId)
          if (blobStat !== undefined) {
            blob.provider = adapterEx.defaultAdapter
            blob.etag = blobStat.etag
            blob.contentType = blobStat.contentType
            blob.version = blobStat.version
            blob.size = blobStat.size
            delete (blob as any).downloadUrl
            delete (blob as any).downloadUrlExpire

            toUpload.push(blob)
          }
        }
      }
      docs = toUpload
    }
    await this.blobAdapter.upload(ctx, domain, docs)
  }

  async clean (ctx: MeasureContext, domain: Domain, docs: Ref<Doc>[]): Promise<void> {
    await Promise.all([this.blobAdapter.clean(ctx, domain, docs), this.client.remove(this.ctx, this.workspaceId, docs)])
  }

  async update (ctx: MeasureContext, domain: Domain, operations: Map<Ref<Doc>, DocumentUpdate<Doc>>): Promise<void> {
    await this.blobAdapter.update(ctx, domain, operations)
  }
}

/**
 * @public
 */
export async function createStorageDataAdapter (
  ctx: MeasureContext,
  hierarchy: Hierarchy,
  url: string,
  workspaceId: WorkspaceId,
  modelDb: ModelDb,
  storage: StorageAdapter
): Promise<DbAdapter> {
  if (storage === undefined) {
    throw new Error('minio storage adapter require minio')
  }
  // We need to create bucket if it doesn't exist
  await storage.make(ctx, workspaceId)

  const storageEx = 'adapters' in storage ? (storage as StorageAdapterEx) : undefined

  const blobAdapter = await createMongoAdapter(ctx, hierarchy, url, workspaceId, modelDb, undefined, {
    calculateHash: (d) => {
      const blob = d as Blob
      if (storageEx?.adapters !== undefined && storageEx.adapters.get(blob.provider) === undefined) {
        return blob.etag + '_' + storageEx.defaultAdapter // Replace tag to be able to move to new provider
      }
      return blob.etag
    }
  })
  return new StorageBlobAdapter(workspaceId, storage, ctx, blobAdapter)
}
