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

import { isWorkspaceCreating, Markup, MeasureContext, systemAccountEmail } from '@hcengineering/core'
import {
  aiBotAccountEmail,
  AIBotTransferEvent,
  OnboardingEvent,
  OnboardingEventRequest,
  OpenChatInSidebarData,
  TranslateRequest,
  TranslateResponse
} from '@hcengineering/ai-bot'
import { WorkspaceInfoRecord } from '@hcengineering/server-ai-bot'
import { getTransactorEndpoint } from '@hcengineering/server-client'
import { generateToken } from '@hcengineering/server-token'
import { WorkspaceLoginInfo } from '@hcengineering/account'
import OpenAI from 'openai'
import { encodingForModel } from 'js-tiktoken'
import { htmlToMarkup, markupToHTML } from '@hcengineering/text'

import { WorkspaceClient } from './workspaceClient'
import { assignBotToWorkspace, getWorkspaceInfo } from './account'
import config from './config'
import { DbStorage } from './storage'
import { SupportWsClient } from './supportWsClient'
import { AIReplyTransferData } from './types'

const POLLING_INTERVAL_MS = 5 * 1000 // 5 seconds
const CLOSE_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes
const ASSIGN_WORKSPACE_DELAY_MS = 5 * 1000 // 5 secs
const MAX_ASSIGN_ATTEMPTS = 5

export class AIBotController {
  private readonly workspaces: Map<string, WorkspaceClient> = new Map<string, WorkspaceClient>()
  private readonly closeWorkspaceTimeouts: Map<string, NodeJS.Timeout> = new Map<string, NodeJS.Timeout>()
  private readonly connectingWorkspaces: Set<string> = new Set<string>()

  private readonly intervalId: NodeJS.Timeout

  readonly aiClient?: OpenAI
  readonly encoding = encodingForModel(config.OpenAIModel)

  supportClient: SupportWsClient | undefined = undefined

  assignTimeout: NodeJS.Timeout | undefined
  assignAttempts = 0

  constructor (
    readonly storage: DbStorage,
    private readonly ctx: MeasureContext
  ) {
    this.aiClient =
      config.OpenAIKey !== ''
        ? new OpenAI({
          apiKey: config.OpenAIKey,
          baseURL: config.OpenAIBaseUrl === '' ? undefined : config.OpenAIBaseUrl
        })
        : undefined

    this.intervalId = setInterval(() => {
      void this.updateWorkspaceClients()
    }, POLLING_INTERVAL_MS)
  }

  async updateWorkspaceClients (): Promise<void> {
    const activeRecords = await this.storage.getActiveWorkspaces()

    if (this.supportClient === undefined && !this.connectingWorkspaces.has(config.SupportWorkspace)) {
      this.connectingWorkspaces.add(config.SupportWorkspace)
      const record = await this.storage.getWorkspace(config.SupportWorkspace)
      this.supportClient = (await this.createWorkspaceClient(
        config.SupportWorkspace,
        record ?? { workspace: config.SupportWorkspace, active: true }
      )) as SupportWsClient
      this.connectingWorkspaces.delete(config.SupportWorkspace)
    }

    for (const record of activeRecords) {
      const ws = record.workspace

      if (this.workspaces.has(ws)) {
        continue
      }

      if (this.connectingWorkspaces.has(ws)) {
        continue
      }

      await this.initWorkspaceClient(ws, record)
    }
  }

  async closeWorkspaceClient (workspace: string): Promise<void> {
    const timeoutId = this.closeWorkspaceTimeouts.get(workspace)

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
      this.closeWorkspaceTimeouts.delete(workspace)
    }

    await this.storage.inactiveWorkspace(workspace)

    const client = this.workspaces.get(workspace)

    if (client !== undefined) {
      await client.close()
      this.workspaces.delete(workspace)
    }
    this.connectingWorkspaces.delete(workspace)
  }

  private async getWorkspaceInfo (ws: string): Promise<WorkspaceLoginInfo | undefined> {
    const systemToken = generateToken(systemAccountEmail, { name: ws })
    for (let i = 0; i < 5; i++) {
      try {
        const info = await getWorkspaceInfo(systemToken)

        if (info == null) {
          this.ctx.warn('Cannot find workspace info', { workspace: ws })
          await wait(ASSIGN_WORKSPACE_DELAY_MS)
          continue
        }

        return info
      } catch (e) {
        this.ctx.error('Error during get workspace info:', { e })
        await wait(ASSIGN_WORKSPACE_DELAY_MS)
      }
    }
  }

  private async assignToWorkspace (workspace: string): Promise<void> {
    clearTimeout(this.assignTimeout)
    try {
      const info = await this.getWorkspaceInfo(workspace)

      if (info === undefined) {
        void this.closeWorkspaceClient(workspace)
        return
      }

      if (isWorkspaceCreating(info?.mode)) {
        this.ctx.info('Workspace is creating -> waiting...', { workspace })
        this.assignTimeout = setTimeout(() => {
          void this.assignToWorkspace(workspace)
        }, ASSIGN_WORKSPACE_DELAY_MS)
        return
      }

      const result = await assignBotToWorkspace(workspace)
      this.ctx.info('Assign to workspace result: ', { result, workspace })
    } catch (e) {
      this.ctx.error('Error during assign workspace:', { e })
      if (this.assignAttempts < MAX_ASSIGN_ATTEMPTS) {
        this.assignAttempts++
        this.assignTimeout = setTimeout(() => {
          void this.assignToWorkspace(workspace)
        }, ASSIGN_WORKSPACE_DELAY_MS)
      } else {
        void this.closeWorkspaceClient(workspace)
      }
    }
  }

  async createWorkspaceClient (workspace: string, info: WorkspaceInfoRecord): Promise<WorkspaceClient> {
    this.ctx.info('Listen workspace: ', { workspace })
    await this.assignToWorkspace(workspace)
    const token = generateToken(aiBotAccountEmail, { name: workspace })
    const endpoint = await getTransactorEndpoint(token)

    if (workspace === config.SupportWorkspace) {
      return new SupportWsClient(endpoint, token, workspace, this, this.ctx.newChild(workspace, {}), info)
    }

    return new WorkspaceClient(endpoint, token, workspace, this, this.ctx.newChild(workspace, {}), info)
  }

  async initWorkspaceClient (workspace: string, info: WorkspaceInfoRecord): Promise<void> {
    if (workspace === config.SupportWorkspace) {
      return
    }
    this.connectingWorkspaces.add(workspace)

    if (!this.workspaces.has(workspace)) {
      const client = await this.createWorkspaceClient(workspace, info)

      this.workspaces.set(workspace, client)
    }

    const timeoutId = this.closeWorkspaceTimeouts.get(workspace)

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }

    const newTimeoutId = setTimeout(() => {
      void this.closeWorkspaceClient(workspace)
    }, CLOSE_INTERVAL_MS)

    this.closeWorkspaceTimeouts.set(workspace, newTimeoutId)
    this.connectingWorkspaces.delete(workspace)
  }

  allowAiReplies (workspace: string, email: string): boolean {
    if (this.supportClient === undefined) return true

    return this.supportClient.allowAiReplies(workspace, email)
  }

  async transferAIReplyToSupport (response: Markup, data: AIReplyTransferData): Promise<void> {
    if (this.supportClient === undefined) return

    await this.supportClient.transferAIReply(response, data)
  }

  async transfer (event: AIBotTransferEvent): Promise<void> {
    const workspace = event.toWorkspace
    const info = await this.storage.getWorkspace(workspace)

    if (workspace === config.SupportWorkspace) {
      if (this.supportClient === undefined) return

      await this.supportClient.transfer(event)
      return
    }

    if (info === undefined) {
      this.ctx.error('Workspace info not found -> cannot transfer event', { workspace })
      return
    }

    await this.initWorkspaceClient(workspace, info)

    const wsClient = this.workspaces.get(workspace)

    if (wsClient === undefined) {
      return
    }

    await wsClient.transfer(event)
  }

  async close (): Promise<void> {
    clearInterval(this.intervalId)

    for (const workspace of this.workspaces.values()) {
      await workspace.close()
    }
    for (const timeoutId of this.closeWorkspaceTimeouts.values()) {
      clearTimeout(timeoutId)
    }
    this.workspaces.clear()
  }

  async updateAvatarInfo (workspace: string, path: string, lastModified: number): Promise<void> {
    await this.storage.updateWorkspace(workspace, { $set: { avatarPath: path, avatarLastModified: lastModified } })
  }

  async openChatInSidebar (data: OpenChatInSidebarData): Promise<void> {
    const record = await this.storage.getWorkspace(data.workspace)

    await this.initWorkspaceClient(data.workspace, record ?? { workspace: data.workspace, active: true })

    const wsClient = this.workspaces.get(data.workspace)

    if (wsClient === undefined) return
    await wsClient.openAIChatInSidebar(data.email)
  }

  async processOnboardingEvent (event: OnboardingEventRequest): Promise<void> {
    switch (event.event) {
      case OnboardingEvent.OpenChatInSidebar:
        await this.openChatInSidebar(event.data as OpenChatInSidebarData)
        break
    }
  }

  async translate (req: TranslateRequest): Promise<TranslateResponse | undefined> {
    if (this.aiClient === undefined) {
      return undefined
    }
    const html = markupToHTML(req.text)
    const start = Date.now()
    const response = await this.aiClient.chat.completions.create({
      model: config.OpenAITranslateModel,
      messages: [
        {
          role: 'system',
          content: `Your task is to translate the text into ${req.lang} while preserving the html structure and metadata`
        },
        {
          role: 'user',
          content: html
        }
      ]
    })
    const end = Date.now()
    this.ctx.info('Translation time: ', { time: end - start })
    const result = response.choices[0].message.content
    const text = result !== null ? htmlToMarkup(result) : req.text
    return {
      text,
      lang: req.lang
    }
  }
}

async function wait (delay: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, delay)
  })
}
