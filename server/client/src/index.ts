//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
// Copyright © 2021, 2022 Hardcore Engineering Inc.
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

import client, { clientId } from '@hcengineering/client'
import {
  Client,
  LoadModelResponse,
  Tx,
  WorkspaceId,
  type BaseWorkspaceInfo,
  type MeasureContext
} from '@hcengineering/core'
import {
  addLocation,
  getMetadata,
  getResource,
  PlatformError,
  setMetadata,
  unknownError
} from '@hcengineering/platform'
import type { StorageAdapter } from '@hcengineering/server-core'
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import plugin from './plugin'

export default plugin

export async function listAccountWorkspaces (token: string): Promise<BaseWorkspaceInfo[]> {
  const accountsUrl = getMetadata(plugin.metadata.Endpoint)
  if (accountsUrl == null) {
    throw new PlatformError(unknownError('No endpoint specified'))
  }
  const workspaces = await (
    await fetch(accountsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        method: 'listWorkspaces',
        params: [token]
      })
    })
  ).json()

  return (workspaces.result as BaseWorkspaceInfo[]) ?? []
}

export async function getTransactorEndpoint (
  token: string,
  kind: 'internal' | 'external' = 'internal',
  timeout: number = -1
): Promise<string> {
  const accountsUrl = getMetadata(plugin.metadata.Endpoint)
  if (accountsUrl == null) {
    throw new PlatformError(unknownError('No endpoint specified'))
  }

  const st = Date.now()
  while (true) {
    try {
      const workspaceInfo: { result: BaseWorkspaceInfo } = await (
        await fetch(accountsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token
          },
          body: JSON.stringify({
            method: 'selectWorkspace',
            params: ['', kind]
          })
        })
      ).json()
      return workspaceInfo.result.endpoint
    } catch (err: any) {
      if (timeout > 0 && st + timeout < Date.now()) {
        // Timeout happened
        throw err
      }
      if (err?.cause?.code === 'ECONNRESET' || err?.cause?.code === 'ECONNREFUSED') {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      } else {
        throw err
      }
    }
  }
}

/**
 * @public
 *
 * If connectTimeout is set, connect will try to connect only specified amount of time, and will return failure if failed.
 */
export async function createClient (
  transactorUrl: string,
  token: string,
  model?: Tx[],
  connectTimeout: number = 0
): Promise<Client> {
  // We need to override default factory with 'ws' one.
  // eslint-disable-next-line
  const WebSocket = require('ws')

  setMetadata(client.metadata.UseBinaryProtocol, true)
  setMetadata(client.metadata.UseProtocolCompression, true)
  setMetadata(client.metadata.ConnectionTimeout, connectTimeout)

  setMetadata(client.metadata.ClientSocketFactory, (url) => {
    const socket = new WebSocket(url, {
      headers: {
        'User-Agent': getMetadata(plugin.metadata.UserAgent) ?? 'Anticrm Client'
      }
    })
    return socket
  })
  addLocation(clientId, () => import('@hcengineering/client-resources'))

  if (model !== undefined) {
    let prev = ''
    const hashes = model.map((it) => {
      const h = crypto.createHash('sha1')
      h.update(prev)
      h.update(JSON.stringify(it))
      prev = h.digest('hex')
      return prev
    })
    setMetadata(client.metadata.OverridePersistenceStore, {
      load: async () => ({
        hash: hashes[hashes.length - 1],
        transactions: model,
        full: true
      }),
      store: async (model: LoadModelResponse) => {}
    })
  }

  const clientFactory = await getResource(client.function.GetClient)
  return await clientFactory(token, transactorUrl)
}

// Will use temporary file to store huge content into
export class BlobClient {
  transactorAPIUrl: string
  index: number
  constructor (
    readonly transactorUrl: string,
    readonly token: string,
    readonly workspace: WorkspaceId,
    readonly opt?: {
      storageAdapter?: StorageAdapter
    }
  ) {
    this.index = 0
    let url = transactorUrl
    if (url.endsWith('/')) {
      url = url.slice(0, url.length - 1)
    }

    this.transactorAPIUrl = url.replaceAll('wss://', 'https://').replace('ws://', 'http://') + '/api/v1/blob'
  }

  async checkFile (ctx: MeasureContext, name: string): Promise<boolean> {
    if (this.opt?.storageAdapter !== undefined) {
      const obj = await this.opt?.storageAdapter.stat(ctx, this.workspace, name)
      if (obj !== undefined) {
        return true
      }
    }
    for (let i = 0; i < 5; i++) {
      try {
        const response = await fetch(this.transactorAPIUrl + `?name=${encodeURIComponent(name)}`, {
          headers: {
            Authorization: 'Bearer ' + this.token,
            Range: 'bytes=0-1'
          }
        })
        if (response.status === 404) {
          return false
        }
        const buff = await response.arrayBuffer()
        return buff.byteLength > 0
      } catch (err: any) {
        if (i === 4) {
          ctx.error('Failed to check file', { name, error: err })
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 500))
      }
    }
    return false
  }

  async writeTo (
    ctx: MeasureContext,
    name: string,
    size: number,
    writable: {
      write: (buffer: Buffer, cb: (err?: any) => void) => void
      end: (cb: () => void) => void
    }
  ): Promise<void> {
    let written = 0
    const chunkSize = 50 * 1024 * 1024
    let writtenMb = 0

    // Use ranges to iterave through file with retry if required.
    while (written < size || size === -1) {
      let i = 0
      let response: Response | undefined
      for (; i < 5; i++) {
        try {
          const st = Date.now()
          let chunk: Buffer

          if (this.opt?.storageAdapter !== undefined) {
            const chunks: Buffer[] = []
            const readable = await this.opt.storageAdapter.partial(ctx, this.workspace, name, written, chunkSize)
            await new Promise<void>((resolve) => {
              readable.on('data', (chunk) => {
                chunks.push(chunk)
              })
              readable.on('end', () => {
                resolve()
              })
            })
            chunk = Buffer.concat(chunks)
          } else {
            const header: Record<string, string> = {
              Authorization: 'Bearer ' + this.token
            }

            if (!(size !== -1 && written === 0 && size < chunkSize)) {
              header.Range = `bytes=${written}-${size === -1 ? written + chunkSize : Math.min(size - 1, written + chunkSize)}`
            }

            response = await fetch(this.transactorAPIUrl + `?name=${encodeURIComponent(name)}`, { headers: header })
            if (header.Range != null) {
              ctx.info('fetch part', { time: Date.now() - st, blobId: name, written, size })
            }
            if (response.status === 403) {
              i = 5
              // No file, so make it empty
              throw new Error(`Unauthorized ${this.transactorAPIUrl}/${this.workspace.name}/${name}`)
            }
            if (response.status === 404) {
              i = 5
              // No file, so make it empty
              throw new Error(`No file for ${this.transactorAPIUrl}/${this.workspace.name}/${name}`)
            }
            if (response.status === 416) {
              if (size === -1) {
                size = parseInt((response.headers.get('content-range') ?? '').split('*/')[1])
                continue
              }

              // No file, so make it empty
              throw new Error(`No file for ${this.transactorAPIUrl}/${this.workspace.name}/${name}`)
            }
            chunk = Buffer.from(await response.arrayBuffer())

            if (header.Range == null) {
              size = chunk.length
            }
            // We need to parse
            // 'Content-Range': `bytes ${start}-${end}/${size}`
            // To determine if something is left
            const range = response.headers.get('Content-Range')
            if (range !== null) {
              const [, total] = range.split(' ')[1].split('/')
              if (total !== undefined) {
                size = parseInt(total)
              }
            }
          }

          await new Promise<void>((resolve, reject) => {
            writable.write(chunk, (err) => {
              if (err != null) {
                reject(err)
              }
              resolve()
            })
          })

          written += chunk.length
          const newWrittenMb = Math.round(written / (1024 * 1024))
          const newWrittenId = Math.round(newWrittenMb / 5)
          if (writtenMb !== newWrittenId) {
            writtenMb = newWrittenId
            ctx.info('  >>>>Chunk', {
              name,
              written: newWrittenMb,
              of: Math.round(size / (1024 * 1024))
            })
          }
          break
        } catch (err: any) {
          if (err?.code === 'NoSuchKey') {
            ctx.info('No such key', { name })
            return
          }
          if (i > 4) {
            await new Promise<void>((resolve) => {
              writable.end(resolve)
            })
            throw err
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 1000))
          // retry
        }
      }
    }
    await new Promise<void>((resolve) => {
      writable.end(resolve)
    })
  }

  async upload (ctx: MeasureContext, name: string, size: number, contentType: string, buffer: Buffer): Promise<void> {
    if (this.opt?.storageAdapter !== undefined) {
      await this.opt.storageAdapter.put(ctx, this.workspace, name, buffer, contentType, size)
    } else {
      // TODO: We need to improve this logig, to allow restore of huge blobs
      for (let i = 0; i < 5; i++) {
        try {
          await fetch(
            this.transactorAPIUrl +
              `?name=${encodeURIComponent(name)}&contentType=${encodeURIComponent(contentType)}&size=${size}`,
            {
              method: 'PUT',
              headers: {
                Authorization: 'Bearer ' + this.token,
                'Content-Type': contentType
              },
              body: buffer
            }
          )
          break
        } catch (err: any) {
          if (i === 4) {
            ctx.error('failed to upload file', { name })
            throw err
          }
        }
      }
    }
  }
}
