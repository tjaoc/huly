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

import {
  type Class,
  type Doc,
  type DocumentQuery,
  type DocumentUpdate,
  type Domain,
  type FieldIndexConfig,
  type FindOptions,
  type FindResult,
  type Hierarchy,
  type MeasureContext,
  type ModelDb,
  type Ref,
  type StorageIterator,
  type Tx,
  type TxResult,
  type WorkspaceId
} from '@hcengineering/core'
import { type StorageAdapter } from './storage'
import type { ServerFindOptions } from './types'

export interface DomainHelperOperations {
  create: (domain: Domain) => Promise<void>
  exists: (domain: Domain) => boolean

  listDomains: () => Promise<Set<Domain>>
  createIndex: (domain: Domain, value: string | FieldIndexConfig<Doc>, options?: { name: string }) => Promise<void>
  dropIndex: (domain: Domain, name: string) => Promise<void>
  listIndexes: (domain: Domain) => Promise<{ name: string }[]>

  // Could return 0 even if it has documents
  estimatedCount: (domain: Domain) => Promise<number>
}

export interface DomainHelper {
  checkDomain: (
    ctx: MeasureContext,
    domain: Domain,
    documents: number,
    operations: DomainHelperOperations
  ) => Promise<void>
}

export interface RawDBAdapterStream<T extends Doc> {
  next: () => Promise<T | undefined>
  close: () => Promise<void>
}

/**
 * @public
 */
export interface RawDBAdapter {
  find: <T extends Doc>(
    ctx: MeasureContext,
    workspace: WorkspaceId,
    domain: Domain,
    query: DocumentQuery<T>,
    options?: Omit<FindOptions<T>, 'projection' | 'lookup' | 'total'>
  ) => Promise<FindResult<T>>
  findStream: <T extends Doc>(
    ctx: MeasureContext,
    workspace: WorkspaceId,
    domain: Domain,
    query: DocumentQuery<T>,
    options?: Omit<FindOptions<T>, 'projection' | 'lookup' | 'total'>
  ) => Promise<RawDBAdapterStream<T>>
  upload: <T extends Doc>(ctx: MeasureContext, workspace: WorkspaceId, domain: Domain, docs: T[]) => Promise<void>
  update: <T extends Doc>(
    ctx: MeasureContext,
    workspace: WorkspaceId,
    domain: Domain,
    docs: Map<Ref<T>, DocumentUpdate<T>>
  ) => Promise<void>
  clean: <T extends Doc>(ctx: MeasureContext, workspace: WorkspaceId, domain: Domain, docs: Ref<T>[]) => Promise<void>
  close: () => Promise<void>
}

export type DbAdapterHandler = (
  domain: Domain,
  event: 'add' | 'update' | 'delete' | 'read',
  count: number,
  helper: DomainHelperOperations
) => void
/**
 * @public
 */
export interface DbAdapter {
  init?: () => Promise<void>

  helper: () => DomainHelperOperations

  close: () => Promise<void>
  findAll: <T extends Doc>(
    ctx: MeasureContext,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: ServerFindOptions<T>
  ) => Promise<FindResult<T>>

  tx: (ctx: MeasureContext, ...tx: Tx[]) => Promise<TxResult[]>

  find: (ctx: MeasureContext, domain: Domain, recheck?: boolean) => StorageIterator

  load: (ctx: MeasureContext, domain: Domain, docs: Ref<Doc>[]) => Promise<Doc[]>
  upload: (ctx: MeasureContext, domain: Domain, docs: Doc[]) => Promise<void>
  clean: (ctx: MeasureContext, domain: Domain, docs: Ref<Doc>[]) => Promise<void>

  groupBy: <T>(ctx: MeasureContext, domain: Domain, field: string) => Promise<Set<T>>

  // Bulk update operations
  update: (ctx: MeasureContext, domain: Domain, operations: Map<Ref<Doc>, DocumentUpdate<Doc>>) => Promise<void>

  // Allow to register a handler to listen for domain operations
  on?: (handler: DbAdapterHandler) => void
}

/**
 * @public
 */
export interface TxAdapter extends DbAdapter {
  getModel: (ctx: MeasureContext) => Promise<Tx[]>
}

/**
 * @public
 */
export type DbAdapterFactory = (
  ctx: MeasureContext,
  hierarchy: Hierarchy,
  url: string,
  workspaceId: WorkspaceId,
  modelDb: ModelDb,
  storage: StorageAdapter
) => Promise<DbAdapter>
