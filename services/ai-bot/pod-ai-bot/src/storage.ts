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

import { MongoClientReference, getMongoClient } from '@hcengineering/mongo'
import { Collection, Db, MongoClient, ObjectId, UpdateFilter, WithId } from 'mongodb'
import { WorkspaceInfoRecord } from '@hcengineering/server-ai-bot'
import { Doc, Ref, SortingOrder } from '@hcengineering/core'

import config from './config'
import { HistoryRecord } from './types'

const clientRef: MongoClientReference = getMongoClient(config.MongoURL)
let client: MongoClient | undefined

export const getDB = (() => {
  return async () => {
    if (client === undefined) {
      client = await clientRef.getClient()
    }

    return client.db(config.ConfigurationDB)
  }
})()

export const closeDB: () => Promise<void> = async () => {
  clientRef.close()
}

export class DbStorage {
  private readonly workspacesInfoCollection: Collection<WorkspaceInfoRecord>
  private readonly historyCollection: Collection<HistoryRecord>

  constructor (private readonly db: Db) {
    this.workspacesInfoCollection = this.db.collection<WorkspaceInfoRecord>('workspacesInfo')
    this.historyCollection = this.db.collection<HistoryRecord>('history')
  }

  async addHistoryRecord (record: HistoryRecord): Promise<ObjectId> {
    return (await this.historyCollection.insertOne(record)).insertedId
  }

  async getHistoryRecords (workspace: string, objectId: Ref<Doc>): Promise<WithId<HistoryRecord>[]> {
    return await this.historyCollection
      .find({ workspace, objectId }, { sort: { timestamp: SortingOrder.Ascending } })
      .toArray()
  }

  async removeHistoryRecords (_ids: ObjectId[]): Promise<void> {
    await this.historyCollection.deleteMany({ _id: { $in: _ids } })
  }

  async getActiveWorkspaces (): Promise<WorkspaceInfoRecord[]> {
    return await this.workspacesInfoCollection.find({ active: true }).toArray()
  }

  async inactiveWorkspace (workspace: string): Promise<void> {
    await this.workspacesInfoCollection.updateOne({ workspace }, { $set: { active: false } })
  }

  async getWorkspace (workspace: string): Promise<WorkspaceInfoRecord | undefined> {
    return (await this.workspacesInfoCollection.findOne({ workspace })) ?? undefined
  }

  async updateWorkspace (workspace: string, update: UpdateFilter<WorkspaceInfoRecord>): Promise<void> {
    await this.workspacesInfoCollection.updateOne({ workspace }, update)
  }
}
