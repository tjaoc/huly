import { toFindResult, type FindResult, type MeasureContext } from '@hcengineering/core'
import { readRequest, type Response } from '@hcengineering/rpc'
import type { Token } from '@hcengineering/server-token'
import type { AddSessionActive, AddSessionResponse, ConnectionSocket, HandleRequestFunction, Session } from './types'

export interface WebsocketData {
  connectionSocket?: ConnectionSocket
  payload: Token
  token: string
  session: Promise<AddSessionResponse> | AddSessionResponse | undefined
  url: string
}

export function doSessionOp (data: WebsocketData, op: (session: AddSessionActive) => void): void {
  if (data.session instanceof Promise) {
    void data.session.then((_session) => {
      data.session = _session
      if ('session' in _session) {
        op(_session)
      }
    })
  } else {
    if (data.session !== undefined && 'session' in data.session) {
      op(data.session)
    }
  }
}

export function processRequest (
  session: Session,
  cs: ConnectionSocket,
  context: MeasureContext,
  workspaceId: string,
  buff: any,
  handleRequest: HandleRequestFunction
): void {
  const request = readRequest(buff, session.binaryMode)
  void handleRequest(context, session, cs, request, workspaceId).then((resp) => {
    if (resp !== undefined) {
      void handleSend(context, cs, resp, 32 * 1024, session.binaryMode, session.useCompression)
    }
  })
}

export function sendResponse (
  ctx: MeasureContext,
  session: Session,
  socket: ConnectionSocket,
  resp: Response<any>
): void {
  void handleSend(ctx, socket, resp, 32 * 1024, session.binaryMode, session.useCompression)
}

function waitNextTick (): Promise<void> | undefined {
  return new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}
export async function handleSend (
  ctx: MeasureContext,
  ws: ConnectionSocket,
  msg: Response<any>,
  chunkLimit: number,
  useBinary: boolean,
  useCompression: boolean
): Promise<void> {
  // ws.send(msg)
  if (Array.isArray(msg.result) && msg.result.length > 1 && chunkLimit > 0) {
    // Split and send by chunks
    const data = [...msg.result]

    let cid = 1
    const dataSize = JSON.stringify(data).length
    const avg = Math.round(dataSize / data.length)
    const itemChunk = Math.round(chunkLimit / avg) + 1

    while (data.length > 0 && !ws.isClosed) {
      let itemChunkCurrent = itemChunk
      if (data.length - itemChunk < itemChunk / 2) {
        itemChunkCurrent = data.length
      }
      const chunk: FindResult<any> = toFindResult(data.splice(0, itemChunkCurrent))
      if (data.length === 0) {
        const orig = msg.result as FindResult<any>
        chunk.total = orig.total ?? 0
        chunk.lookupMap = orig.lookupMap
      }
      if (chunk !== undefined) {
        await ws.send(
          ctx,
          { ...msg, result: chunk, chunk: { index: cid, final: data.length === 0 } },
          useBinary,
          useCompression
        )
      }
      cid++

      if (data.length > 0 && !ws.isClosed) {
        await waitNextTick()
      }
    }
  } else {
    await ws.send(ctx, msg, useBinary, useCompression)
  }
}
