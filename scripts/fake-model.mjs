// A local stand-in for the model API, for checking what DSH sends. Listens on 127.0.0.1 only.
//
//   node scripts/fake-model.mjs <port> <request-log.jsonl>
//   DEEPSEEK_BASE_URL=http://127.0.0.1:<port> DEEPSEEK_API_KEY=any-dummy-value dsh dsh-awr-dev "task"
//
// Every request DSH makes is appended to the log as one JSON line (method, url, body). It answers
// every POST with a Messages-API reply (streamed or not): the next action and first open loop it
// finds in the messages it was sent, or "I see no AWR context."; FAKE_REPLY replaces that text.
// The key is a dummy and never leaves the machine. Used for DSH-014; useful for any check of what
// the plugin puts in front of the model.
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'
const [,, port, log] = process.argv
writeFileSync(log, '')
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((b) => b.text ?? '').join('')
createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString()
    let body; try { body = JSON.parse(raw) } catch { body = undefined }
    appendFileSync(log, JSON.stringify({ at: Date.now(), method: req.method, url: req.url, body }) + '\n')
    if (req.method !== 'POST' || !body) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [] })); return }
    const all = (body.messages ?? []).map((m) => textOf(m.content)).join('\n')
    const loops = all.match(/Checkpoint Open Loops:\n([^\n]+)/)?.[1]
    const next = all.match(/Next Action:\n([^\n]+)/)?.[1]
    const reply = process.env.FAKE_REPLY ?? (next ? `Next action in my context: ${next}${loops ? ` | first open loop: ${loops}` : ''}` : 'I see no AWR context.')
    if (body.stream === false) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } })); return }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`)
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } })
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    ev('message_stop', {})
    res.end()
  })
}).listen(Number(port), '127.0.0.1', () => console.log('listening', port))
