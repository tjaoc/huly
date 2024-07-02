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

import { CopyObjectCommand, GetObjectCommand, PutObjectCommand, S3 } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import core, {
  toWorkspaceString,
  withContext,
  type Blob,
  type BlobLookup,
  type Branding,
  type MeasureContext,
  type Ref,
  type WorkspaceId,
  type WorkspaceIdWithUrl
} from '@hcengineering/core'

import {
  type BlobStorageIterator,
  type ListBlobResult,
  type StorageAdapter,
  type StorageConfig,
  type StorageConfiguration,
  type UploadedObjectInfo
} from '@hcengineering/server-core'
import { Readable } from 'stream'

import { removeAllObjects, type BlobLookupResult, type BucketInfo } from '@hcengineering/storage'
import type { ReadableStream } from 'stream/web'

export interface S3Config extends StorageConfig {
  kind: 's3'
  accessKey: string
  secretKey: string
  region?: string

  // If defined, all resources will be inside selected root bucket.
  rootBucket?: string

  // A prefix string to be added to a bucketId in case rootBucket not used
  bucketPrefix?: string

  // If not specified will be enabled
  allowPresign?: string
  // Expire time for presigned URIs
  expireTime?: string
}

/**
 * @public
 */
export class S3Service implements StorageAdapter {
  static config = 's3'
  expireTime: number
  client: S3
  contentTypes?: string[]
  constructor (readonly opt: S3Config) {
    this.client = new S3({
      endpoint: opt.endpoint,
      credentials: {
        accessKeyId: opt.accessKey,
        secretAccessKey: opt.secretKey
      },
      region: opt.region ?? 'auto'
    })

    this.expireTime = parseInt(this.opt.expireTime ?? '168') * 3600 // use 7 * 24 - hours as default value for expireF
    this.contentTypes = opt.contentTypes
  }

  async initialize (ctx: MeasureContext, workspaceId: WorkspaceId): Promise<void> {}

  async lookup (
    ctx: MeasureContext,
    workspaceId: WorkspaceIdWithUrl,
    branding: Branding | null,
    docs: Blob[]
  ): Promise<BlobLookupResult> {
    const result: BlobLookupResult = {
      lookups: [],
      updates: new Map()
    }
    const now = Date.now()
    for (const d of docs) {
      // Let's add current from URI for previews.
      const bl = d as BlobLookup
      const command = new GetObjectCommand({
        Bucket: this.getBucketId(workspaceId),
        Key: this.getDocumentKey(workspaceId, d.storageId),
        ResponseCacheControl: 'max-age=9d'
      })
      if (
        (bl.downloadUrl === undefined || (bl.downloadUrlExpire ?? 0) < now) &&
        (this.opt.allowPresign ?? 'true') === 'true'
      ) {
        bl.downloadUrl = await getSignedUrl(this.client, command, {
          expiresIn: this.expireTime
        })
        bl.downloadUrlExpire = now + this.expireTime * 1000
        result.updates?.set(bl._id, {
          downloadUrl: bl.downloadUrl,
          downloadUrlExpire: bl.downloadUrlExpire
        })
      }

      result.lookups.push(bl)
    }
    // this.client.presignedUrl(httpMethod, bucketName, objectName, callback)
    return result
  }

  /**
   * @public
   */
  getBucketId (workspaceId: WorkspaceId): string {
    return this.opt.rootBucket ?? (this.opt.bucketPrefix ?? '') + toWorkspaceString(workspaceId, '.')
  }

  getBucketFolder (workspaceId: WorkspaceId): string {
    return toWorkspaceString(workspaceId, '.')
  }

  async close (): Promise<void> {}

  async exists (ctx: MeasureContext, workspaceId: WorkspaceId): Promise<boolean> {
    try {
      const result = await this.client.headBucket({
        Bucket: this.getBucketId(workspaceId)
      })
      return result.$metadata.httpStatusCode === 200
    } catch (err: any) {
      if (err.name === '400') {
        // No bucket exisrs
        return false
      }
    }
    // No API to check is bucket exists or not, so we need to call make and check if it already exists.
    return false
  }

  @withContext('make')
  async make (ctx: MeasureContext, workspaceId: WorkspaceId): Promise<void> {
    try {
      await this.client.createBucket({
        Bucket: this.getBucketId(workspaceId)
      })
    } catch (err: any) {
      if (err.Code === 'BucketAlreadyOwnedByYou') {
        return
      }
      ctx.error('error during create bucket', { err })
    }
  }

  async listBuckets (ctx: MeasureContext, productId: string): Promise<BucketInfo[]> {
    try {
      if (this.opt.rootBucket !== undefined) {
        const info = new Map<string, BucketInfo>()
        let token: string | undefined

        while (true) {
          const res = await this.client.listObjectsV2({
            Bucket: this.opt.rootBucket,
            Prefix: '',
            Delimiter: '/',
            ContinuationToken: token
          })
          for (const data of res.CommonPrefixes ?? []) {
            const wsName = data.Prefix?.split('/')?.[0]
            if (wsName !== undefined && !info.has(wsName)) {
              info.set(wsName, {
                name: wsName,
                delete: async () => {
                  await this.delete(ctx, { name: wsName, productId })
                },
                list: async () => await this.listStream(ctx, { name: wsName, productId })
              })
            }
          }
          if (res.IsTruncated === true) {
            token = res.NextContinuationToken
          } else {
            break
          }
        }
        return Array.from(info.values())
      } else {
        const productPostfix = this.getBucketFolder({
          name: '',
          productId
        })
        const buckets = await this.client.listBuckets()
        return (buckets.Buckets ?? [])
          .filter((it) => it.Name !== undefined && it.Name.endsWith(productPostfix))
          .map((it) => {
            let name = it.Name ?? ''
            name = name.slice(0, name.length - productPostfix.length)
            return {
              name,
              delete: async () => {
                await this.delete(ctx, { name, productId })
              },
              list: async () => await this.listStream(ctx, { name, productId })
            }
          })
      }
    } catch (err: any) {
      if (err.Code === 'NoSuchBucket') {
        return []
      }
      ctx.error('failed to list buckets', { rootBucket: this.opt.rootBucket })
      console.error(err)
      return []
    }
  }

  getDocumentKey (workspace: WorkspaceId, name: string): string {
    return this.opt.rootBucket === undefined ? name : `${this.getBucketFolder(workspace)}/${name}`
  }

  @withContext('remove')
  async remove (ctx: MeasureContext, workspaceId: WorkspaceId, objectNames: string[]): Promise<void> {
    await this.client.deleteObjects({
      Bucket: this.getBucketId(workspaceId),
      Delete: {
        Objects: objectNames.map((it) => ({ Key: this.getDocumentKey(workspaceId, it) }))
      }
    })
  }

  @withContext('delete')
  async delete (ctx: MeasureContext, workspaceId: WorkspaceId): Promise<void> {
    try {
      await removeAllObjects(ctx, this, workspaceId)
    } catch (err: any) {
      ctx.error('failed t oclean all objecrs', { error: err })
    }
    if (this.opt.rootBucket === undefined) {
      // We should also delete bucket
      await this.client.deleteBucket({
        Bucket: this.getBucketId(workspaceId)
      })
    }
  }

  stripPrefix (prefix: string | undefined, key: string): string {
    if (prefix !== undefined && key.startsWith(prefix)) {
      return key.slice(prefix.length)
    }
    return key
  }

  rootPrefix (workspaceId: WorkspaceId): string | undefined {
    return this.opt.rootBucket !== undefined ? this.getBucketFolder(workspaceId) + '/' : undefined
  }

  async copy (sourceId: WorkspaceId, targetId: WorkspaceId, objectName: string): Promise<void> {
    const copyOp = new CopyObjectCommand({
      Bucket: this.getBucketId(targetId),
      Key: this.getDocumentKey(targetId, objectName),
      CopySource: `${this.getBucketId(sourceId)}/${this.getDocumentKey(sourceId, objectName)}`
    })
    await this.client.send(copyOp)
  }

  @withContext('listStream')
  async listStream (
    ctx: MeasureContext,
    workspaceId: WorkspaceId,
    prefix?: string | undefined
  ): Promise<BlobStorageIterator> {
    let hasMore = true
    const buffer: ListBlobResult[] = []
    let token: string | undefined

    const rootPrefix = this.rootPrefix(workspaceId)
    return {
      next: async (): Promise<ListBlobResult | undefined> => {
        try {
          if (hasMore && buffer.length === 0) {
            const res = await this.client.listObjectsV2({
              Bucket: this.getBucketId(workspaceId),
              Prefix: rootPrefix !== undefined ? rootPrefix + (prefix ?? '') : prefix ?? '',
              ContinuationToken: token
            })
            if (res.IsTruncated === true) {
              token = res.NextContinuationToken
            } else {
              hasMore = false
            }

            for (const data of res.Contents ?? []) {
              const _id = this.stripPrefix(rootPrefix, data.Key ?? '')
              buffer.push({
                _id: _id as Ref<Blob>,
                _class: core.class.Blob,
                etag: data.ETag ?? '',
                size: data.Size ?? 0,
                provider: this.opt.name,
                space: core.space.Configuration,
                modifiedBy: core.account.ConfigUser,
                modifiedOn: data.LastModified?.getTime() ?? 0,
                storageId: _id
              })
            }
          }
        } catch (err: any) {
          ctx.error('Failed to get list', { error: err, workspaceId: workspaceId.name, prefix })
        }
        if (buffer.length > 0) {
          return buffer.shift()
        }
        if (!hasMore) {
          return undefined
        }
      },
      close: async () => {}
    }
  }

  @withContext('stat')
  async stat (ctx: MeasureContext, workspaceId: WorkspaceId, objectName: string): Promise<Blob | undefined> {
    try {
      const result = await this.client.headObject({
        Bucket: this.getBucketId(workspaceId),
        Key: this.getDocumentKey(workspaceId, objectName)
      })
      const rootPrefix = this.rootPrefix(workspaceId)
      return {
        provider: '',
        _class: core.class.Blob,
        _id: this.stripPrefix(rootPrefix, objectName) as Ref<Blob>,
        storageId: this.stripPrefix(rootPrefix, objectName),
        contentType: result.ContentType ?? '',
        size: result.ContentLength ?? 0,
        etag: result.ETag ?? '',
        space: core.space.Configuration,
        modifiedBy: core.account.System,
        modifiedOn: result.LastModified?.getTime() ?? 0,
        version: result.VersionId ?? null
      }
    } catch (err: any) {
      ctx.error('no object found', { error: err, objectName, workspaceId: workspaceId.name })
    }
  }

  @withContext('get')
  async get (ctx: MeasureContext, workspaceId: WorkspaceId, objectName: string): Promise<Readable> {
    return await this.doGet(ctx, workspaceId, objectName)
  }

  async doGet (ctx: MeasureContext, workspaceId: WorkspaceId, objectName: string, range?: string): Promise<Readable> {
    const res = await this.client.getObject({
      Bucket: this.getBucketId(workspaceId),
      Key: this.getDocumentKey(workspaceId, objectName),
      Range: range
    })

    const stream = res.Body?.transformToWebStream()

    if (stream !== undefined) {
      return Readable.fromWeb(stream as ReadableStream<any>)
    } else {
      const readable = new Readable()
      readable._read = () => {}
      readable.push(null)
      return readable
    }
  }

  @withContext('put')
  async put (
    ctx: MeasureContext,
    workspaceId: WorkspaceId,
    objectName: string,
    stream: Readable | Buffer | string,
    contentType: string,
    size?: number
  ): Promise<UploadedObjectInfo> {
    if (size !== undefined && size < 1024 * 1024 * 5) {
      return await ctx.with(
        'simple-put',
        {},
        async () => {
          const cmd = new PutObjectCommand({
            Bucket: this.getBucketId(workspaceId),
            Key: this.getDocumentKey(workspaceId, objectName),
            ContentType: contentType,
            ContentLength: size,
            Body: stream
          })
          const response = await this.client.send(cmd)
          return {
            etag: response.ETag ?? '',
            versionId: response.VersionId ?? null
          }
        },
        { size, objectName, workspaceId: workspaceId.name }
      )
      // Less 5Mb
    } else {
      return await ctx.with(
        'multipart-upload',
        {},
        async () => {
          const uploadTask = new Upload({
            client: this.client,
            params: {
              Bucket: this.getBucketId(workspaceId),
              Key: this.getDocumentKey(workspaceId, objectName),
              ContentType: contentType,
              Body: stream
            },

            // (optional) concurrency configuration
            // queueSize: 1,

            // (optional) size of each part, in bytes, at least 5MB
            partSize: 1024 * 1024 * 5,
            leavePartsOnError: false
          })

          const output = await uploadTask.done()
          return {
            etag: output.ETag ?? '',
            versionId: output.VersionId ?? null
          }
        },
        { size, objectName, workspaceId: workspaceId.name }
      )
    }
  }

  @withContext('read')
  async read (ctx: MeasureContext, workspaceId: WorkspaceId, name: string): Promise<Buffer[]> {
    const data = await this.doGet(ctx, workspaceId, name)
    const chunks: Buffer[] = []

    await new Promise((resolve, reject) => {
      data.on('data', (chunk) => {
        chunks.push(chunk)
      })

      data.on('end', () => {
        data.destroy()
        resolve(null)
      })
      data.on('error', (err) => {
        data.destroy()
        reject(err)
      })
    })
    return chunks
  }

  @withContext('partial')
  async partial (
    ctx: MeasureContext,
    workspaceId: WorkspaceId,
    objectName: string,
    offset: number,
    length?: number
  ): Promise<Readable> {
    const range = length !== undefined ? `bytes=${offset}-${offset + length}` : `bytes=${offset}-`
    return await this.doGet(ctx, workspaceId, objectName, range)
  }
}

export function processConfigFromEnv (storageConfig: StorageConfiguration): string | undefined {
  const endpoint = process.env.S3_ENDPOINT
  if (endpoint === undefined) {
    return 'S3_ENDPOINT'
  }
  const accessKey = process.env.S3_ACCESS_KEY
  if (accessKey === undefined) {
    return 'S3_ACCESS_KEY'
  }

  const secretKey = process.env.S3_SECRET_KEY
  if (secretKey === undefined) {
    return 'S3_SECRET_KEY'
  }

  const minioConfig: S3Config = {
    kind: 's3',
    name: 's3',
    region: 'auto',
    endpoint,
    accessKey,
    secretKey
  }
  storageConfig.storages.push(minioConfig)
  storageConfig.default = 's3'
}
