// A local stand-in for the model API, for checking what DSH sends. Listens on 127.0.0.1 only.
//
//   node scripts/fake-model.mjs <port> <request-log.jsonl>
//   DEEPSEEK_BASE_URL=http://127.0.0.1:<port> DEEPSEEK_API_KEY=any-dummy-value dsh dsh-awr-dev "task"
//
// Every request DSH makes is appended to the log as one JSON line (method, url, body). It answers
// every POST with a Messages-API reply (streamed or not): the next action and first open loop it
// finds in the messages it was sent, or "I see no AWR context."; FAKE_REPLY replaces that text.
// FAKE_TOOL=<name> (and FAKE_TOOL_INPUT=<json>) makes it call that tool on the first request of a
// turn that offers tools, then answer "tool_result: <what the tool returned>". The same settings can
// live in a JSON file named by FAKE_CONTROL, which is read on every request.
// The key is a dummy and never leaves the machine. Used for DSH-014; useful for any check of what
// the plugin puts in front of the model.
import { createServer } from 'node:http'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
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
    // FAKE_CONTROL=<file.json> holds the same settings as the environment and is read on every request,
    // so a check can change what the stand-in does without restarting it.
    let cfg = process.env
    if (process.env.FAKE_CONTROL) { try { cfg = { ...process.env, ...JSON.parse(readFileSync(process.env.FAKE_CONTROL, 'utf8')) } } catch { /* keep the environment */ } }
    const last = (body.messages ?? []).at(-1)
    const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : []
    const offered = (body.tools ?? []).map((t) => t.name)
    if (cfg.FAKE_TOOL && offered.length > 0) {
      appendFileSync(log, JSON.stringify({ at: Date.now(), offered }) + '\n')
      if (results.length === 0 && offered.includes(cfg.FAKE_TOOL)) {
        const input = JSON.stringify(JSON.parse(cfg.FAKE_TOOL_INPUT ?? '{}'))
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const send = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`)
        send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
        send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_fake1', name: cfg.FAKE_TOOL, input: {} } })
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: input } })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
        send('message_stop', {})
        res.end()
        return
      }
    }
    const toolText = results.map((r) => textOf(r.content)).join('\n')
    const reply = results.length > 0 ? `tool_result: ${toolText.slice(0, 3000)}` : cfg.FAKE_REPLY ?? (next ? `Next action in my context: ${next}${loops ? ` | first open loop: ${loops}` : ''}` : 'I see no AWR context.')
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
