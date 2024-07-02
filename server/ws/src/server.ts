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

import { Analytics } from '@hcengineering/analytics'
import core, {
  TxFactory,
  WorkspaceEvent,
  generateId,
  systemAccountEmail,
  toWorkspaceString,
  versionToString,
  withContext,
  type BaseWorkspaceInfo,
  type Branding,
  type BrandingMap,
  type MeasureContext,
  type Tx,
  type TxWorkspaceEvent,
  type WorkspaceId
} from '@hcengineering/core'
import { unknownError, type Status } from '@hcengineering/platform'
import { type HelloRequest, type HelloResponse, type Request, type Response } from '@hcengineering/rpc'
import type { Pipeline, StorageAdapter } from '@hcengineering/server-core'
import { type Token } from '@hcengineering/server-token'

import {
  LOGGING_ENABLED,
  type ClientSessionCtx,
  type ConnectionSocket,
  type PipelineFactory,
  type ServerFactory,
  type Session,
  type SessionManager,
  type Workspace
} from './types'
import { sendResponse } from './utils'

interface WorkspaceLoginInfo extends Omit<BaseWorkspaceInfo, 'workspace'> {
  upgrade?: {
    toProcess: number
    total: number
    elapsed: number
    eta: number
  }
  workspaceId: string
}

function timeoutPromise (time: number): { promise: Promise<void>, cancelHandle: () => void } {
  let timer: any
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(resolve, time)
    }),
    cancelHandle: () => {
      clearTimeout(timer)
    }
  }
}

/**
 * @public
 */
export interface Timeouts {
  // Timeout preferences
  pingTimeout: number // Default 1 second
  reconnectTimeout: number // Default 3 seconds
}

class TSessionManager implements SessionManager {
  private readonly statusPromises = new Map<string, Promise<void>>()
  readonly workspaces = new Map<string, Workspace>()
  checkInterval: any

  sessions = new Map<string, { session: Session, socket: ConnectionSocket }>()
  reconnectIds = new Map<string, any>()

  maintenanceTimer: any
  timeMinutes = 0

  modelVersion = process.env.MODEL_VERSION ?? ''

  constructor (
    readonly ctx: MeasureContext,
    readonly sessionFactory: (token: Token, pipeline: Pipeline) => Session,
    readonly timeouts: Timeouts,
    readonly brandingMap: BrandingMap
  ) {
    this.checkInterval = setInterval(() => {
      this.handleInterval()
    }, timeouts.pingTimeout)
  }

  scheduleMaintenance (timeMinutes: number): void {
    this.timeMinutes = timeMinutes

    this.sendMaintenanceWarning()

    const nextTime = (): number => (this.timeMinutes > 1 ? 60 * 1000 : this.timeMinutes * 60 * 1000)

    const showMaintenance = (): void => {
      if (this.timeMinutes > 1) {
        this.timeMinutes -= 1
        clearTimeout(this.maintenanceTimer)
        this.maintenanceTimer = setTimeout(showMaintenance, nextTime())
      } else {
        this.timeMinutes = 0
      }

      this.sendMaintenanceWarning()
    }

    clearTimeout(this.maintenanceTimer)
    this.maintenanceTimer = setTimeout(showMaintenance, nextTime())
  }

  private sendMaintenanceWarning (): void {
    if (this.timeMinutes === 0) {
      return
    }
    const event: TxWorkspaceEvent = this.createMaintenanceWarning()
    for (const ws of this.workspaces.values()) {
      this.broadcastAll(ws, [event])
    }
  }

  private createMaintenanceWarning (): TxWorkspaceEvent {
    return {
      _id: generateId(),
      _class: core.class.TxWorkspaceEvent,
      event: WorkspaceEvent.MaintenanceNotification,
      modifiedBy: core.account.System,
      modifiedOn: Date.now(),
      objectSpace: core.space.DerivedTx,
      space: core.space.DerivedTx,
      createdBy: core.account.System,
      params: {
        timeMinutes: this.timeMinutes
      }
    }
  }

  ticks = 0

  handleInterval (): void {
    for (const [wsId, workspace] of this.workspaces.entries()) {
      for (const s of workspace.sessions) {
        if (this.ticks % (5 * 60) === 0) {
          s[1].session.mins5.find = s[1].session.current.find
          s[1].session.mins5.tx = s[1].session.current.tx

          s[1].session.current = { find: 0, tx: 0 }
        }
        const now = Date.now()
        const diff = now - s[1].session.lastRequest

        let timeout = 60000
        if (s[1].session.getUser() === systemAccountEmail) {
          timeout = timeout * 10
        }

        if (diff > timeout && this.ticks % 10 === 0) {
          this.ctx.warn('session hang, closing...', { wsId, user: s[1].session.getUser() })

          // Force close workspace if only one client and it hang.
          void this.close(this.ctx, s[1].socket, wsId)
          continue
        }
        if (diff > 20000 && diff < 60000 && this.ticks % 10 === 0) {
          void s[1].socket.send(
            workspace.context,
            { result: 'ping' },
            s[1].session.binaryMode,
            s[1].session.useCompression
          )
        }

        for (const r of s[1].session.requests.values()) {
          if (now - r.start > 30000) {
            this.ctx.warn('request hang found, 30sec', {
              wsId,
              user: s[1].session.getUser(),
              ...r.params
            })
          }
        }
      }

      // Wait some time for new client to appear before closing workspace.
      if (workspace.sessions.size === 0 && workspace.closing === undefined) {
        workspace.softShutdown--
        if (workspace.softShutdown <= 0) {
          this.ctx.warn('closing workspace, no users', {
            workspace: workspace.workspaceId.name,
            wsId,
            upgrade: workspace.upgrade,
            backup: workspace.backup
          })
          workspace.closing = this.performWorkspaceCloseCheck(workspace, workspace.workspaceId, wsId)
        }
      } else {
        workspace.softShutdown = 3
      }
    }
    this.ticks++
  }

  createSession (token: Token, pipeline: Pipeline): Session {
    return this.sessionFactory(token, pipeline)
  }

  @withContext('get-workspace-info')
  async getWorkspaceInfo (ctx: MeasureContext, accounts: string, token: string): Promise<WorkspaceLoginInfo> {
    const userInfo = await (
      await fetch(accounts, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          method: 'getWorkspaceInfo',
          params: [true]
        })
      })
    ).json()
    if (userInfo.error !== undefined) {
      ctx.error('Error response from account service', { error: JSON.stringify(userInfo) })
      throw new Error(JSON.stringify(userInfo.error))
    }

    return { ...userInfo.result, upgrade: userInfo.upgrade }
  }

  @withContext('📲 add-session')
  async addSession (
    ctx: MeasureContext,
    ws: ConnectionSocket,
    token: Token,
    rawToken: string,
    pipelineFactory: PipelineFactory,
    productId: string,
    sessionId: string | undefined,
    accountsUrl: string
  ): Promise<
    | { session: Session, context: MeasureContext, workspaceId: string }
    | { upgrade: true, upgradeInfo?: WorkspaceLoginInfo['upgrade'] }
    | { error: any }
    > {
    const wsString = toWorkspaceString(token.workspace, '@')

    let workspaceInfo: WorkspaceLoginInfo | undefined
    for (let i = 0; i < 5; i++) {
      try {
        workspaceInfo =
          accountsUrl !== '' ? await this.getWorkspaceInfo(ctx, accountsUrl, rawToken) : this.wsFromToken(token)
        break
      } catch (err: any) {
        if (i === 4) {
          throw err
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    if (workspaceInfo?.creating === true && token.email !== systemAccountEmail) {
      // No access to workspace for token.
      return { error: new Error(`Workspace during creation phase ${token.email} ${token.workspace.name}`) }
    }
    if (workspaceInfo === undefined && token.extra?.admin !== 'true') {
      // No access to workspace for token.
      return { error: new Error(`No access to workspace for token ${token.email} ${token.workspace.name}`) }
    } else if (workspaceInfo === undefined) {
      workspaceInfo = this.wsFromToken(token)
    }

    if (
      this.modelVersion !== '' &&
      workspaceInfo.version !== undefined &&
      this.modelVersion !== versionToString(workspaceInfo.version) &&
      token.extra?.model !== 'upgrade' &&
      token.extra?.mode !== 'backup'
    ) {
      ctx.warn('model version mismatch', {
        version: this.modelVersion,
        workspaceVersion: versionToString(workspaceInfo.version)
      })
      // Version mismatch, return upgrading.
      return { upgrade: true, upgradeInfo: workspaceInfo.upgrade }
    }

    let workspace = this.workspaces.get(wsString)
    if (workspace?.closing !== undefined) {
      await workspace?.closing
    }
    workspace = this.workspaces.get(wsString)
    const oldSession = sessionId !== undefined ? workspace?.sessions?.get(sessionId) : undefined
    if (oldSession !== undefined) {
      // Just close old socket for old session id.
      await this.close(ctx, oldSession.socket, wsString)
    }
    const workspaceName = workspaceInfo.workspaceName ?? workspaceInfo.workspaceUrl ?? workspaceInfo.workspaceId
    const branding =
      (workspaceInfo.branding !== undefined
        ? Object.values(this.brandingMap).find((b) => b.key === (workspaceInfo as WorkspaceLoginInfo).branding)
        : null) ?? null

    if (workspace === undefined) {
      ctx.warn('open workspace', {
        email: token.email,
        workspace: workspaceInfo.workspaceId,
        wsUrl: workspaceInfo.workspaceUrl,
        ...token.extra
      })
      workspace = this.createWorkspace(
        ctx.parent ?? ctx,
        pipelineFactory,
        token,
        workspaceInfo.workspaceUrl ?? workspaceInfo.workspaceId,
        workspaceName,
        branding
      )
    }

    let pipeline: Pipeline
    if (token.extra?.model === 'upgrade') {
      if (workspace.upgrade) {
        ctx.warn('reconnect workspace in upgrade', {
          email: token.email,
          workspace: workspaceInfo.workspaceId,
          wsUrl: workspaceInfo.workspaceUrl
        })
        pipeline = await ctx.with('💤 wait', { workspaceName }, async () => await (workspace as Workspace).pipeline)
      } else {
        ctx.warn('reconnect workspace in upgrade switch', {
          email: token.email,
          workspace: workspaceInfo.workspaceId,
          wsUrl: workspaceInfo.workspaceUrl
        })
        // We need to wait in case previous upgeade connection is already closing.
        pipeline = await this.switchToUpgradeSession(
          token,
          sessionId,
          ctx.parent ?? ctx,
          wsString,
          workspace,
          pipelineFactory,
          ws,
          workspaceInfo.workspaceUrl ?? workspaceInfo.workspaceId,
          workspaceName
        )
      }
    } else {
      if (workspace.upgrade) {
        ctx.warn('connect during upgrade', {
          email: token.email,
          workspace: workspace.workspaceId.name,
          sessionUsers: Array.from(workspace.sessions.values()).map((it) => it.session.getUser()),
          sessionData: Array.from(workspace.sessions.values()).map((it) => it.socket.data())
        })
        return { upgrade: true }
      }
      pipeline = await ctx.with('💤 wait', { workspaceName }, async () => await (workspace as Workspace).pipeline)
    }

    const session = this.createSession(token, pipeline)

    session.sessionId = sessionId !== undefined && (sessionId ?? '').trim().length > 0 ? sessionId : generateId()
    session.sessionInstanceId = generateId()
    this.sessions.set(ws.id, { session, socket: ws })
    // We need to delete previous session with Id if found.
    workspace.sessions.set(session.sessionId, { session, socket: ws })

    // We do not need to wait for set-status, just return session to client
    const _workspace = workspace
    void ctx.with('set-status', {}, (ctx) => this.trySetStatus(ctx, session, true, _workspace.workspaceId))

    if (this.timeMinutes > 0) {
      void ws.send(ctx, { result: this.createMaintenanceWarning() }, session.binaryMode, session.useCompression)
    }
    return { session, context: workspace.context, workspaceId: wsString }
  }

  private wsFromToken (token: Token): WorkspaceLoginInfo {
    return {
      workspaceId: token.workspace.name,
      workspaceUrl: token.workspace.name,
      workspaceName: token.workspace.name,
      createdBy: '',
      createdOn: Date.now(),
      lastVisit: Date.now(),
      productId: '',
      createProgress: 100,
      creating: false,
      disabled: false
    }
  }

  private async switchToUpgradeSession (
    token: Token,
    sessionId: string | undefined,
    ctx: MeasureContext,
    wsString: string,
    workspace: Workspace,
    pipelineFactory: PipelineFactory,
    ws: ConnectionSocket,
    workspaceUrl: string,
    workspaceName: string
  ): Promise<Pipeline> {
    if (LOGGING_ENABLED) {
      ctx.info('reloading workspace', { workspaceName, token: JSON.stringify(token) })
    }

    // Mark as upgrade, to prevent any new clients to connect during close
    workspace.upgrade = true
    workspace.backup = token.extra?.mode === 'backup'
    // If upgrade client is used.
    // Drop all existing clients
    workspace.closing = this.closeAll(wsString, workspace, 0, 'upgrade')
    await workspace.closing
    // Wipe workspace and update values.
    workspace.workspaceName = workspaceName
    if (!workspace.upgrade) {
      // This is previous workspace, intended to be closed.
      workspace.id = generateId()
      workspace.sessions = new Map()
    }
    // Re-create pipeline.
    workspace.pipeline = pipelineFactory(
      ctx,
      { ...token.workspace, workspaceUrl, workspaceName },
      true,
      (tx, targets, exclude) => {
        this.broadcastAll(workspace, tx, targets, exclude)
      },
      workspace.branding
    )
    return await workspace.pipeline
  }

  broadcastAll (workspace: Workspace, tx: Tx[], target?: string | string[], exclude?: string[]): void {
    if (workspace.upgrade) {
      return
    }
    if (target !== undefined && !Array.isArray(target)) {
      target = [target]
    }
    const ctx = this.ctx.newChild('📬 broadcast-all', {})
    const sessions = [...workspace.sessions.values()].filter((it) => {
      if (it === undefined) {
        return false
      }
      const tt = it.session.getUser()
      return (target === undefined && !(exclude ?? []).includes(tt)) || (target?.includes(tt) ?? false)
    })
    function send (): void {
      for (const session of sessions) {
        try {
          void sendResponse(ctx, session.session, session.socket, { result: tx })
        } catch (err: any) {
          Analytics.handleError(err)
          ctx.error('error during send', { error: err })
        }
      }
      ctx.end()
    }
    if (sessions.length > 0) {
      // We need to send broadcast after our client response so put it after all IO
      send()
    } else {
      ctx.end()
    }
  }

  broadcast (
    from: Session | null,
    workspaceId: WorkspaceId,
    resp: Tx[],
    target: string | undefined,
    exclude?: string[]
  ): void {
    const workspace = this.workspaces.get(toWorkspaceString(workspaceId))
    if (workspace === undefined) {
      this.ctx.error('internal: cannot find sessions', {
        workspaceId: workspaceId.name,
        target,
        userId: from?.getUser() ?? '$unknown'
      })
      return
    }
    if (workspace?.upgrade ?? false) {
      return
    }
    if (LOGGING_ENABLED) {
      this.ctx.info('server broadcasting to clients...', {
        workspace: workspaceId.name,
        count: workspace.sessions.size
      })
    }

    const sessions = [...workspace.sessions.values()]
    const ctx = this.ctx.newChild('📭 broadcast', {})
    function send (): void {
      for (const sessionRef of sessions) {
        const tt = sessionRef.session.getUser()
        if ((target === undefined && !(exclude ?? []).includes(tt)) || (target?.includes(tt) ?? false)) {
          void sendResponse(ctx, sessionRef.session, sessionRef.socket, { result: resp })
        }
      }
      ctx.end()
    }
    if (sessions.length > 0) {
      // We need to send broadcast after our client response so put it after all IO
      send()
    } else {
      ctx.end()
    }
  }

  private createWorkspace (
    ctx: MeasureContext,
    pipelineFactory: PipelineFactory,
    token: Token,
    workspaceUrl: string,
    workspaceName: string,
    branding: Branding | null
  ): Workspace {
    const upgrade = token.extra?.model === 'upgrade'
    const backup = token.extra?.mode === 'backup'
    const context = ctx.newChild('🧲 session', {})
    const pipelineCtx = context.newChild('🧲 pipeline-factory', {})
    const workspace: Workspace = {
      context,
      id: generateId(),
      pipeline: pipelineFactory(
        pipelineCtx,
        { ...token.workspace, workspaceUrl, workspaceName },
        upgrade,
        (tx, targets) => {
          this.broadcastAll(workspace, tx, targets)
        },
        branding
      ),
      sessions: new Map(),
      softShutdown: 3,
      upgrade,
      backup,
      workspaceId: token.workspace,
      workspaceName,
      branding
    }
    this.workspaces.set(toWorkspaceString(token.workspace), workspace)
    return workspace
  }

  private async trySetStatus (
    ctx: MeasureContext,
    session: Session,
    online: boolean,
    workspaceId: WorkspaceId
  ): Promise<void> {
    const current = this.statusPromises.get(session.getUser())
    if (current !== undefined) {
      await current
    }
    const promise = this.setStatus(ctx, session, online, workspaceId)
    this.statusPromises.set(session.getUser(), promise)
    await promise
    this.statusPromises.delete(session.getUser())
  }

  private async setStatus (
    ctx: MeasureContext,
    session: Session,
    online: boolean,
    workspaceId: WorkspaceId
  ): Promise<void> {
    try {
      const user = (
        await session.pipeline().modelDb.findAll(
          core.class.Account,
          {
            email: session.getUser()
          },
          { limit: 1 }
        )
      )[0]
      if (user === undefined) return

      const clientCtx: ClientSessionCtx = {
        sendResponse: async (msg) => {
          // No response
        },
        ctx,
        send: async (msg, target, exclude) => {
          this.broadcast(null, workspaceId, msg, target, exclude)
        },
        sendError: async (msg, error: Status) => {
          // Assume no error send
        }
      }

      const status = (await session.findAllRaw(ctx, core.class.UserStatus, { user: user._id }, { limit: 1 }))[0]
      const txFactory = new TxFactory(user._id, true)
      if (status === undefined) {
        const tx = txFactory.createTxCreateDoc(core.class.UserStatus, core.space.Space, {
          online,
          user: user._id
        })
        await session.tx(clientCtx, tx)
      } else if (status.online !== online) {
        const tx = txFactory.createTxUpdateDoc(status._class, status.space, status._id, {
          online
        })
        await session.tx(clientCtx, tx)
      }
    } catch {}
  }

  async close (ctx: MeasureContext, ws: ConnectionSocket, wsid: string): Promise<void> {
    const workspace = this.workspaces.get(wsid)

    const sessionRef = this.sessions.get(ws.id)
    if (sessionRef !== undefined) {
      ctx.info('bye happen', {
        workspace: workspace?.workspaceName,
        user: sessionRef.session.getUser(),
        binary: sessionRef.session.binaryMode,
        compression: sessionRef.session.useCompression,
        totalTime: Date.now() - sessionRef.session.createTime,
        workspaceUsers: workspace?.sessions?.size,
        totalUsers: this.sessions.size
      })
      this.sessions.delete(ws.id)
      if (workspace !== undefined) {
        workspace.sessions.delete(sessionRef.session.sessionId)
      }
      this.reconnectIds.set(
        sessionRef.session.sessionId,
        setTimeout(() => {
          this.reconnectIds.delete(sessionRef.session.sessionId)

          const user = sessionRef.session.getUser()
          if (workspace !== undefined) {
            const another = Array.from(workspace.sessions.values()).findIndex((p) => p.session.getUser() === user)
            if (another === -1 && !workspace.upgrade) {
              void this.trySetStatus(workspace.context, sessionRef.session, false, workspace.workspaceId)
            }
          }
        }, this.timeouts.reconnectTimeout)
      )
      try {
        sessionRef.socket.close()
      } catch (err) {
        // Ignore if closed
      }
    }
  }

  async forceClose (wsId: string, ignoreSocket?: ConnectionSocket): Promise<void> {
    const ws = this.workspaces.get(wsId)
    if (ws !== undefined) {
      ws.upgrade = true // We need to similare upgrade to refresh all clients.
      ws.closing = this.closeAll(wsId, ws, 99, 'force-close', ignoreSocket)
      await ws.closing
      this.workspaces.delete(wsId)
    }
  }

  async closeAll (
    wsId: string,
    workspace: Workspace,
    code: number,
    reason: 'upgrade' | 'shutdown' | 'force-close',
    ignoreSocket?: ConnectionSocket
  ): Promise<void> {
    if (LOGGING_ENABLED) {
      this.ctx.warn('closing workspace', {
        workspace: workspace.id,
        wsName: workspace.workspaceName,
        code,
        reason,
        wsId
      })
    }

    const sessions = Array.from(workspace.sessions)
    workspace.sessions = new Map()

    const closeS = async (s: Session, webSocket: ConnectionSocket): Promise<void> => {
      s.workspaceClosed = true
      if (reason === 'upgrade' || reason === 'force-close') {
        // Override message handler, to wait for upgrading response from clients.
        this.sendUpgrade(workspace.context, webSocket, s.binaryMode)
      }
      webSocket.close()
    }

    if (LOGGING_ENABLED) {
      this.ctx.warn('Clients disconnected. Closing Workspace...', {
        wsId,
        workspace: workspace.id,
        wsName: workspace.workspaceName
      })
    }
    await Promise.all(
      sessions.filter((it) => it[1].socket.id !== ignoreSocket?.id).map((s) => closeS(s[1].session, s[1].socket))
    )

    const closePipeline = async (): Promise<void> => {
      try {
        await this.ctx.with('close-pipeline', {}, async () => {
          await (await workspace.pipeline).close()
        })
      } catch (err: any) {
        Analytics.handleError(err)
        this.ctx.error('close-pipeline-error', { error: err })
      }
    }
    await this.ctx.with('closing', {}, async () => {
      const to = timeoutPromise(120000)
      await Promise.race([closePipeline(), to.promise])
      to.cancelHandle()
    })
    if (LOGGING_ENABLED) {
      this.ctx.warn('Workspace closed...', { workspace: workspace.id, wsId, wsName: workspace.workspaceName })
    }
  }

  private sendUpgrade (ctx: MeasureContext, webSocket: ConnectionSocket, binary: boolean): void {
    void webSocket.send(
      ctx,
      {
        result: {
          _class: core.class.TxModelUpgrade
        }
      },
      binary,
      false
    )
  }

  async closeWorkspaces (ctx: MeasureContext): Promise<void> {
    clearInterval(this.checkInterval)
    for (const w of this.workspaces) {
      await this.closeAll(w[0], w[1], 1, 'shutdown')
    }
  }

  private async performWorkspaceCloseCheck (
    workspace: Workspace,
    workspaceId: WorkspaceId,
    wsid: string
  ): Promise<void> {
    const wsUID = workspace.id
    const logParams = { wsid, workspace: workspace.id, wsName: workspaceId.name }
    if (workspace.sessions.size === 0) {
      if (LOGGING_ENABLED) {
        this.ctx.warn('no sessions for workspace', logParams)
      }
      try {
        if (workspace.sessions.size === 0) {
          const pl = await workspace.pipeline
          let to = timeoutPromise(60000)
          await Promise.race([pl, to.promise])
          to.cancelHandle()
          to = timeoutPromise(60000)
          await Promise.race([pl.close(), to])
          to.cancelHandle()

          if (this.workspaces.get(wsid)?.id === wsUID) {
            this.workspaces.delete(wsid)
          }
          workspace.context.end()
          if (LOGGING_ENABLED) {
            this.ctx.warn('Closed workspace', logParams)
          }
        }
      } catch (err: any) {
        Analytics.handleError(err)
        this.workspaces.delete(wsid)
        if (LOGGING_ENABLED) {
          this.ctx.error('failed', { ...logParams, error: err })
        }
      }
    } else {
      if (LOGGING_ENABLED) {
        this.ctx.info('few sessions for workspace, close skipped', {
          ...logParams,
          sessions: workspace.sessions.size
        })
      }
    }
  }

  handleRequest<S extends Session>(
    requestCtx: MeasureContext,
    service: S,
    ws: ConnectionSocket,
    request: Request<any>,
    workspace: string // wsId, toWorkspaceString()
  ): void {
    const userCtx = requestCtx.newChild('📞 client', {
      workspace: '🧲 ' + workspace
    })

    // Calculate total number of clients
    const reqId = generateId()

    const st = Date.now()
    try {
      const backupMode = 'loadChunk' in service
      void userCtx.with(`🧭 ${backupMode ? 'handleBackup' : 'handleRequest'}`, {}, async (ctx) => {
        if (request.time != null) {
          const delta = Date.now() - request.time
          userCtx.measure('receive msg', delta)
        }
        const wsRef = this.workspaces.get(workspace)
        if (wsRef === undefined) {
          await ws.send(
            ctx,
            {
              id: request.id,
              error: unknownError('No workspace')
            },
            service.binaryMode,
            service.useCompression
          )
          return
        }
        if (request.method === 'forceClose') {
          let done = false
          if (wsRef.upgrade) {
            done = true
            console.log('FORCE CLOSE', workspace)
            // In case of upgrade, we need to force close workspace not in interval handler
            await this.forceClose(workspace, ws)
          }
          const forceCloseResponse: Response<any> = {
            id: request.id,
            result: done
          }
          await ws.send(ctx, forceCloseResponse, service.binaryMode, service.useCompression)
          return
        }
        if (request.id === -1 && request.method === 'hello') {
          const hello = request as HelloRequest
          service.binaryMode = hello.binary ?? false
          service.useCompression = hello.compression ?? false

          if (LOGGING_ENABLED) {
            ctx.info('hello happen', {
              workspace,
              user: service.getUser(),
              binary: service.binaryMode,
              compression: service.useCompression,
              timeToHello: Date.now() - service.createTime,
              workspaceUsers: this.workspaces.get(workspace)?.sessions?.size,
              totalUsers: this.sessions.size
            })
          }
          const reconnect = this.reconnectIds.has(service.sessionId)
          if (reconnect) {
            const reconnectTimeout = this.reconnectIds.get(service.sessionId)
            clearTimeout(reconnectTimeout)
            this.reconnectIds.delete(service.sessionId)
          }
          const helloResponse: HelloResponse = {
            id: -1,
            result: 'hello',
            binary: service.binaryMode,
            reconnect
          }
          await ws.send(ctx, helloResponse, false, false)
          return
        }
        const opContext = (ctx: MeasureContext): ClientSessionCtx => ({
          sendResponse: async (msg) => {
            await sendResponse(ctx, service, ws, {
              id: request.id,
              result: msg,
              time: Date.now() - st,
              bfst: Date.now(),
              queue: service.requests.size
            })
            userCtx.end()
          },
          ctx,
          send: async (msg, target, exclude) => {
            this.broadcast(service, wsRef.workspaceId, msg, target, exclude)
          },
          sendError: async (msg, error: Status) => {
            await sendResponse(ctx, service, ws, {
              id: request.id,
              result: msg,
              error,
              time: Date.now() - st,
              bfst: Date.now(),
              queue: service.requests.size
            })
          }
        })

        if (request.method === 'measure' || request.method === 'measure-done') {
          await this.handleMeasure<S>(service, request, opContext(ctx))
          return
        }
        service.requests.set(reqId, {
          id: reqId,
          params: request,
          start: st
        })
        if (request.id === -1 && request.method === '#upgrade') {
          ws.close()
          return
        }

        const f = (service as any)[request.method]
        try {
          const params = [...request.params]

          service.measureCtx?.ctx !== undefined
            ? await f.apply(service, [opContext(service.measureCtx?.ctx), ...params])
            : await ctx.with('🧨 process', {}, async (callTx) => f.apply(service, [opContext(callTx), ...params]))
        } catch (err: any) {
          Analytics.handleError(err)
          if (LOGGING_ENABLED) {
            this.ctx.error('error handle request', { error: err, request })
          }
          await ws.send(
            ctx,
            {
              id: request.id,
              error: unknownError(err),
              result: JSON.parse(JSON.stringify(err?.stack))
            },
            service.binaryMode,
            service.useCompression
          )
        }
      })
    } finally {
      userCtx.end()
      service.requests.delete(reqId)
    }
  }

  private async handleMeasure<S extends Session>(
    service: S,
    request: Request<any[]>,
    ctx: ClientSessionCtx
  ): Promise<void> {
    let serverTime = 0
    if (request.method === 'measure') {
      service.measureCtx = { ctx: ctx.ctx.newChild('📶 ' + request.params[0], {}), time: Date.now() }
    } else {
      if (service.measureCtx !== undefined) {
        serverTime = Date.now() - service.measureCtx.time
        service.measureCtx.ctx.end(serverTime)
        service.measureCtx = undefined
      }
    }
    try {
      await ctx.sendResponse(request.method === 'measure' ? 'started' : serverTime)
    } catch (err: any) {
      Analytics.handleError(err)
      if (LOGGING_ENABLED) {
        ctx.ctx.error('error handle measure', { error: err, request })
      }
      await ctx.sendError(JSON.parse(JSON.stringify(err?.stack)), unknownError(err))
    }
  }
}

/**
 * @public
 */
export function start (
  ctx: MeasureContext,
  opt: {
    port: number
    pipelineFactory: PipelineFactory
    sessionFactory: (token: Token, pipeline: Pipeline) => Session
    productId: string
    brandingMap: BrandingMap
    serverFactory: ServerFactory
    enableCompression?: boolean
    accountsUrl: string
    externalStorage: StorageAdapter
  } & Partial<Timeouts>
): () => Promise<void> {
  const sessions = new TSessionManager(
    ctx,
    opt.sessionFactory,
    {
      pingTimeout: opt.pingTimeout ?? 10000,
      reconnectTimeout: 500
    },
    opt.brandingMap
  )
  return opt.serverFactory(
    sessions,
    (rctx, service, ws, msg, workspace) => {
      sessions.handleRequest(rctx, service, ws, msg, workspace)
    },
    ctx,
    opt.pipelineFactory,
    opt.port,
    opt.productId,
    opt.enableCompression ?? false,
    opt.accountsUrl,
    opt.externalStorage
  )
}
