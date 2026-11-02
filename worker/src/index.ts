// Cloudflare Worker：POST /mcp 是 MCP 端点（Streamable HTTP，JSON 应答）；
// 一桌一个 Durable Object，桌号从工具参数里的 room 取。
import { DurableObject } from 'cloudflare:workers'
import { handleRpc, parseRpc, roomOf, type JsonRpcRequest, type JsonRpcResponse, type TableStore } from './mcp.ts'
import type { GameState } from '../../src/engine/game.ts'

export interface Env {
  TABLE: DurableObjectNamespace<Table>
  // 用 `wrangler secret put EMBER_API_KEY` 或 Cloudflare 控制台 Secret 注入。
  // 绝不能把真实密钥写进仓库。
  EMBER_API_KEY?: string
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

function authorized(request: Request, env: Env): boolean {
  const expected = env.EMBER_API_KEY
  if (!expected) return false
  const url = new URL(request.url)
  const auth = request.headers.get('authorization') ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const apiKey = (request.headers.get('x-api-key') ?? '').trim()
  const queryToken = (url.searchParams.get('token') ?? '').trim()
  return (bearer.length > 0 && sameSecret(bearer, expected)) ||
    (apiKey.length > 0 && sameSecret(apiKey, expected)) ||
    (queryToken.length > 0 && sameSecret(queryToken, expected))
}

export class Table extends DurableObject<Env> {
  private store: TableStore = {
    load: async () => (await this.ctx.storage.get<GameState>('state')) ?? null,
    save: async (state) => {
      if (state) await this.ctx.storage.put('state', state)
      else await this.ctx.storage.delete('state')
    },
  }

  // RPC 参数走 JSON 字符串：JSON-RPC 里有 unknown 字段，直接传对象会被 Workers 的可序列化类型推成 never。
  async rpc(reqJson: string): Promise<string> {
    const req = JSON.parse(reqJson) as JsonRpcRequest
    const res: JsonRpcResponse | null = await handleRpc(req, this.store)
    return JSON.stringify(res ? [res] : [])
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('Ember · 余温 MCP server. POST JSON-RPC to /mcp. https://github.com/chaodeng060-source/ember-cards', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    if (url.pathname !== '/mcp') return json({ error: 'not found' }, 404)
    if (!env.EMBER_API_KEY) return json({ error: 'server auth is not configured' }, 503)
    if (!authorized(request, env)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { ...JSON_HEADERS, 'www-authenticate': 'Bearer realm="ember-cards"' },
      })
    }
    if (request.method === 'GET') return json({ error: 'SSE stream not offered; use POST' }, 405)
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
    }
    const reqs = parseRpc(body)
    if (!reqs) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, 400)

    const responses: unknown[] = []
    for (const r of reqs) {
      if (r.method === 'tools/call') {
        const room = roomOf(r.params)
        if (!room) {
          const res = await handleRpc(r, null)
          if (res) responses.push(res)
          continue
        }
        const stub = env.TABLE.get(env.TABLE.idFromName(room))
        responses.push(...(JSON.parse(await stub.rpc(JSON.stringify(r))) as JsonRpcResponse[]))
      } else {
        const res = await handleRpc(r, null)
        if (res) responses.push(res)
      }
    }
    if (responses.length === 0) return new Response(null, { status: 202 })
    return json(Array.isArray(body) ? responses : responses[0])
  },
}
