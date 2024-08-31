//
// Copyright © 2023 Hardcore Engineering Inc.
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

import { Account, Ref } from '@hcengineering/core'
import { type Db } from 'mongodb'
import { type CalendarClient } from './calendar'
import config from './config'
import { type ProjectCredentials, type Token, type User } from './types'
import { WorkspaceClient } from './workspaceClient'

export class CalendarController {
  private readonly workspaces: Map<string, WorkspaceClient> = new Map<string, WorkspaceClient>()

  private readonly credentials: ProjectCredentials
  private readonly clients: Map<string, CalendarClient[]> = new Map<string, CalendarClient[]>()

  protected static _instance: CalendarController

  private constructor (private readonly mongo: Db) {
    this.credentials = JSON.parse(config.Credentials)
    CalendarController._instance = this
  }

  static getCalendarController (mongo?: Db): CalendarController {
    if (CalendarController._instance !== undefined) {
      return CalendarController._instance
    }
    if (mongo === undefined) throw new Error('CalendarController not exist')
    return new CalendarController(mongo)
  }

  async startAll (): Promise<void> {
    const tokens = await this.mongo.collection<Token>('tokens').find().toArray()
    for (const token of tokens) {
      try {
        await this.createClient(token)
      } catch (err) {
        console.error(`Couldn't create client for ${token.workspace} ${token.userId}`)
      }
    }

    for (const client of this.workspaces.values()) {
      void client.sync()
    }
  }

  push (email: string, mode: 'events' | 'calendar', calendarId?: string): void {
    const clients = this.clients.get(email)
    for (const client of clients ?? []) {
      if (mode === 'calendar') {
        void client.syncCalendars(email)
      }
      if (mode === 'events' && calendarId !== undefined) {
        void client.sync(calendarId, email)
      }
    }
  }

  addClient (email: string, client: CalendarClient): void {
    const clients = this.clients.get(email)
    if (clients === undefined) {
      this.clients.set(email, [client])
    } else {
      clients.push(client)
      this.clients.set(email, clients)
    }
  }

  removeClient (email: string): void {
    const clients = this.clients.get(email)
    if (clients !== undefined) {
      this.clients.set(
        email,
        clients.filter((p) => !p.isClosed)
      )
    }
  }

  async getUserId (email: string, workspace: string): Promise<Ref<Account>> {
    const workspaceClient = await this.getWorkspaceClient(workspace)
    return await workspaceClient.getUserId(email)
  }

  async signout (workspace: string, value: string): Promise<void> {
    const workspaceClient = await this.getWorkspaceClient(workspace)
    const clients = await workspaceClient.signout(value)
    if (clients === 0) {
      this.workspaces.delete(workspace)
    }
  }

  removeWorkspace (workspace: string): void {
    this.workspaces.delete(workspace)
  }

  async close (): Promise<void> {
    for (const workspace of this.workspaces.values()) {
      await workspace.close()
    }
    this.workspaces.clear()
  }

  async createClient (user: Token): Promise<CalendarClient> {
    const workspace = await this.getWorkspaceClient(user.workspace)
    const newClient = await workspace.createCalendarClient(user)
    return newClient
  }

  async newClient (user: User, code: string): Promise<CalendarClient> {
    const workspace = await this.getWorkspaceClient(user.workspace)
    const newClient = await workspace.newCalendarClient(user, code)
    return newClient
  }

  private async getWorkspaceClient (workspace: string): Promise<WorkspaceClient> {
    let res = this.workspaces.get(workspace)
    if (res === undefined) {
      try {
        res = await WorkspaceClient.create(this.credentials, this.mongo, workspace, this)
        this.workspaces.set(workspace, res)
      } catch (err) {
        console.error(`Couldn't create workspace worker for ${workspace}, reason: ${JSON.stringify(err)}`)
        throw err
      }
    }
    return res
  }
}
