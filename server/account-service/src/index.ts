//
// Copyright © 2023 Hardcore Engineering Inc.
//

import account, {
  ACCOUNT_DB,
  EndpointKind,
  UpgradeWorker,
  accountId,
  cleanExpiredOtp,
  cleanInProgressWorkspaces,
  getAllTransactors,
  getMethods
} from '@hcengineering/account'
import accountEn from '@hcengineering/account/lang/en.json'
import accountRu from '@hcengineering/account/lang/ru.json'
import { Analytics } from '@hcengineering/analytics'
import { registerProviders } from '@hcengineering/auth-providers'
import {
  metricsAggregate,
  type BrandingMap,
  type Data,
  type MeasureContext,
  type Tx,
  type Version
} from '@hcengineering/core'
import { type MigrateOperation } from '@hcengineering/model'
import { getMongoClient, type MongoClientReference } from '@hcengineering/mongo'
import platform, { Severity, Status, addStringsLoader, setMetadata } from '@hcengineering/platform'
import serverClientPlugin from '@hcengineering/server-client'
import serverToken, { decodeToken } from '@hcengineering/server-token'
import toolPlugin from '@hcengineering/server-tool'
import cors from '@koa/cors'
import { type IncomingHttpHeaders } from 'http'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import Router from 'koa-router'
import type { MongoClient } from 'mongodb'
import os from 'os'

/**
 * @public
 */
export function serveAccount (
  measureCtx: MeasureContext,
  version: Data<Version>,
  txes: Tx[],
  migrateOperations: [string, MigrateOperation][],
  brandings: BrandingMap,
  onClose?: () => void
): void {
  console.log('Starting account service with brandings: ', brandings)
  const methods = getMethods(version, txes, migrateOperations)
  const ACCOUNT_PORT = parseInt(process.env.ACCOUNT_PORT ?? '3000')
  const dbUri = process.env.MONGO_URL
  if (dbUri === undefined) {
    console.log('Please provide mongodb url')
    process.exit(1)
  }

  const transactorUri = process.env.TRANSACTOR_URL
  if (transactorUri === undefined) {
    console.log('Please provide transactor url')
    process.exit(1)
  }

  const serverSecret = process.env.SERVER_SECRET
  if (serverSecret === undefined) {
    console.log('Please provide server secret')
    process.exit(1)
  }

  addStringsLoader(accountId, async (lang: string) => {
    switch (lang) {
      case 'en':
        return accountEn
      case 'ru':
        return accountRu
      default:
        return accountEn
    }
  })

  const ses = process.env.SES_URL
  const frontURL = process.env.FRONT_URL
  const productName = process.env.PRODUCT_NAME
  const lang = process.env.LANGUAGE ?? 'en'

  setMetadata(account.metadata.Transactors, transactorUri)
  setMetadata(platform.metadata.locale, lang)
  setMetadata(account.metadata.ProductName, productName)
  setMetadata(account.metadata.OtpTimeToLiveSec, parseInt(process.env.OTP_TIME_TO_LIVE ?? '60'))
  setMetadata(account.metadata.OtpRetryDelaySec, parseInt(process.env.OTP_RETRY_DELAY ?? '60'))
  setMetadata(account.metadata.SES_URL, ses)
  setMetadata(account.metadata.FrontURL, frontURL)

  setMetadata(serverToken.metadata.Secret, serverSecret)

  const initWS = process.env.INIT_WORKSPACE
  if (initWS !== undefined) {
    setMetadata(toolPlugin.metadata.InitWorkspace, initWS)
  }
  const initScriptUrl = process.env.INIT_SCRIPT_URL
  if (initScriptUrl !== undefined) {
    setMetadata(toolPlugin.metadata.InitScriptURL, initScriptUrl)
  }
  setMetadata(serverClientPlugin.metadata.UserAgent, 'AccountService')

  const client: MongoClientReference = getMongoClient(dbUri)
  let _client: MongoClient | Promise<MongoClient> = client.getClient()

  let worker: UpgradeWorker | undefined

  const app = new Koa()
  const router = new Router()

  app.use(
    cors({
      credentials: true
    })
  )
  app.use(bodyParser())

  void client.getClient().then(async (p: MongoClient) => {
    const db = p.db(ACCOUNT_DB)
    registerProviders(measureCtx, app, router, db, serverSecret, frontURL, brandings)

    // We need to clean workspace with creating === true, since server is restarted.
    void cleanInProgressWorkspaces(db)

    setInterval(
      () => {
        void cleanExpiredOtp(db)
      },
      3 * 60 * 1000
    )

    const performUpgrade = (process.env.PERFORM_UPGRADE ?? 'true') === 'true'
    if (performUpgrade) {
      await measureCtx.with('upgrade-all-models', {}, async (ctx) => {
        worker = new UpgradeWorker(db, p, version, txes, migrateOperations)
        await worker.upgradeAll(ctx, {
          errorHandler: async (ws, err) => {
            Analytics.handleError(err)
          },
          force: false,
          console: false,
          logs: 'upgrade-logs',
          parallel: parseInt(process.env.PARALLEL ?? '1')
        })
      })
    }
  })

  const extractToken = (header: IncomingHttpHeaders): string | undefined => {
    try {
      return header.authorization?.slice(7) ?? undefined
    } catch {
      return undefined
    }
  }

  router.get('/api/v1/statistics', (req, res) => {
    try {
      const token = req.query.token as string
      const payload = decodeToken(token)
      const admin = payload.extra?.admin === 'true'
      const data: Record<string, any> = {
        metrics: admin ? metricsAggregate((measureCtx as any).metrics) : {},
        statistics: {}
      }
      data.statistics.totalClients = 0
      data.statistics.memoryUsed = Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100
      data.statistics.memoryTotal = Math.round((process.memoryUsage().heapTotal / 1024 / 1024) * 100) / 100
      data.statistics.cpuUsage = Math.round(os.loadavg()[0] * 100) / 100
      data.statistics.freeMem = Math.round((os.freemem() / 1024 / 1024) * 100) / 100
      data.statistics.totalMem = Math.round((os.totalmem() / 1024 / 1024) * 100) / 100
      const json = JSON.stringify(data)
      req.res.writeHead(200, { 'Content-Type': 'application/json' })
      req.res.end(json)
    } catch (err: any) {
      Analytics.handleError(err)
      console.error(err)
      req.res.writeHead(404, {})
      req.res.end()
    }
  })

  router.put('/api/v1/manage', async (req, res) => {
    try {
      const token = req.query.token as string
      const payload = decodeToken(token)
      if (payload.extra?.admin !== 'true') {
        req.res.writeHead(404, {})
        req.res.end()
        return
      }

      const operation = req.query.operation

      switch (operation) {
        case 'maintenance': {
          const timeMinutes = parseInt((req.query.timeout as string) ?? '5')
          const transactors = getAllTransactors(EndpointKind.Internal)
          for (const tr of transactors) {
            const serverEndpoint = tr.replaceAll('wss://', 'https://').replace('ws://', 'http://')
            await fetch(serverEndpoint + `/api/v1/manage?token=${token}&operation=maintenance&timeout=${timeMinutes}`, {
              method: 'PUT'
            })
          }

          req.res.writeHead(200)
          req.res.end()
          return
        }
      }

      req.res.writeHead(404, {})
      req.res.end()
    } catch (err: any) {
      Analytics.handleError(err)
      req.res.writeHead(404, {})
      req.res.end()
    }
  })

  router.post('rpc', '/', async (ctx) => {
    const token = extractToken(ctx.request.headers)

    const request = ctx.request.body as any
    const method = methods[request.method]
    if (method === undefined) {
      const response = {
        id: request.id,
        error: new Status(Severity.ERROR, platform.status.UnknownMethod, { method: request.method })
      }

      ctx.body = JSON.stringify(response)
    }

    if (_client instanceof Promise) {
      _client = await _client
    }
    const db = _client.db(ACCOUNT_DB)

    let host: string | undefined
    const origin = ctx.request.headers.origin ?? ctx.request.headers.referer
    if (origin !== undefined) {
      host = new URL(origin).host
    }
    const branding = host !== undefined ? brandings[host] : null
    const result = await measureCtx.with(
      request.method,
      {},
      async (ctx) => await method(ctx, db, branding, request, token)
    )

    worker?.updateResponseStatistics(result)
    ctx.body = result
  })

  app.use(router.routes()).use(router.allowedMethods())

  const server = app.listen(ACCOUNT_PORT, () => {
    console.log(`server started on port ${ACCOUNT_PORT}`)
  })

  const close = (): void => {
    onClose?.()
    if (client instanceof Promise) {
      void client.then((c) => c.close())
    } else {
      client.close()
    }
    server.close()
  }

  process.on('uncaughtException', (e) => {
    measureCtx.error('uncaughtException', { error: e })
  })

  process.on('unhandledRejection', (reason, promise) => {
    measureCtx.error('Unhandled Rejection at:', { reason, promise })
  })
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
  process.on('exit', close)
}
