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

import {
  type Class,
  type Doc,
  type DocumentQuery,
  type FindOptions,
  type FindResult,
  type MeasureContext,
  type Ref
} from '@hcengineering/core'

import { deepEqual } from 'fast-equals'
import type { ServerStorage } from '../types'

interface Query {
  _class: Ref<Class<Doc>>
  query: DocumentQuery<Doc>
  result: FindResult<Doc> | Promise<FindResult<Doc>> | undefined
  options?: FindOptions<Doc>
  callbacks: number
  max: number
}
/**
 * @public
 */
export class QueryJoiner {
  private readonly queries: Map<Ref<Class<Doc>>, Query[]> = new Map<Ref<Class<Doc>>, Query[]>()

  constructor (readonly _findAll: ServerStorage['findAll']) {}

  async findAll<T extends Doc>(
    ctx: MeasureContext,
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Promise<FindResult<T>> {
    // Will find a query or add + 1 to callbacks
    const q = this.findQuery(_class, query, options) ?? this.createQuery(_class, query, options)
    if (q.result === undefined) {
      q.result = this._findAll(ctx, _class, query, options)
    }
    if (q.result instanceof Promise) {
      q.result = await q.result
      q.callbacks--
    }
    this.removeFromQueue(q)

    return q.result as FindResult<T>
  }

  private findQuery<T extends Doc>(
    _class: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ): Query | undefined {
    const queries = this.queries.get(_class)
    if (queries === undefined) return
    for (const q of queries) {
      if (!deepEqual(query, q.query) || !deepEqual(options, q.options)) {
        continue
      }
      q.callbacks++
      q.max++
      return q
    }
  }

  private createQuery<T extends Doc>(_class: Ref<Class<T>>, query: DocumentQuery<T>, options?: FindOptions<T>): Query {
    const queries = this.queries.get(_class) ?? []
    const q: Query = {
      _class,
      query,
      result: undefined,
      options: options as FindOptions<Doc>,
      callbacks: 1,
      max: 1
    }

    queries.push(q)
    this.queries.set(_class, queries)
    return q
  }

  private removeFromQueue (q: Query): void {
    if (q.callbacks === 0) {
      const queries = this.queries.get(q._class) ?? []
      this.queries.set(
        q._class,
        queries.filter((it) => it !== q)
      )
    }
  }
}
