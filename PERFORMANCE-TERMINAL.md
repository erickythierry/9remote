# Performance do caminho de terminal (TTY → web)

Análise estática do caminho de output: PTY no daemon → agente → clientes (web/APK). Nenhum
benchmark foi rodado. Cada item abaixo foi conferido no código e tem efeito concreto; o que
era micro-otimização ou arriscado demais para o ganho foi removido.

```
PTY (node-pty, daemon)
  → onData → session.pending += data
  → setImmediate → Buffer.from(pending).toString("base64") → JSON + "\n" → unix socket
  → ptyDaemonClient: messageBuffer += chunk.toString(); split("\n"); JSON.parse
  → terminalSocket: base64 → Buffer → fatias de 45KB
  → broadcast(io, "output") para todas as conexões → socket.io
```

## 1. Parser do daemon client corrompe UTF-8 (bug de correção)

`host/features/terminal/ptyDaemonClient.ts`, handler `client.on("data")`:

```ts
messageBuffer += chunk.toString();
```

Um caractere multibyte (acento, box-drawing de TUI) partido entre dois chunks do socket vira
`�`. Também faz `split` da string inteira a cada chunk, o que pesa no replay de 256KB do
`joinSession`.

Correção: um `StringDecoder("utf8")` por conexão (`decoder.write(chunk)` no lugar de
`chunk.toString()`). Resolve o bug com uma linha. O custo do `split` só vale atacar se a
medição mostrar.

## 2. Trim do scrollback copia 2MB por chunk

`host/features/terminal/ptyDaemon.ts`, `onData` (~linha 457):

```ts
const totalSize = bufferTotal(session.buffer);
if (totalSize > MAX_BUFFER_SIZE) {
  session.buffer = [takeBufferTail(session.buffer, MAX_BUFFER_SIZE)];
}
```

`bufferTotal` percorre o array inteiro a cada chunk. Com o buffer cheio (2MB), todo chunk novo
dispara `takeBufferTail`, que faz `Buffer.concat` de 2MB e realoca. Em TUI que streama (Claude
Code, build logs) é uma cópia de 2MB por chunk, o custo dominante do daemon.

Correção: manter `session.bufferBytes` incremental. Ao estourar o cap, descartar chunks inteiros
da cabeça (`shift`) até ficar abaixo do limite, e fazer `subarray` só no chunk de fronteira.
`takeBufferTail` fica restrito ao `joinSession`, que já o usa para alinhar o início em ESC.
Todos os outros usos de `session.buffer` (`bufferTotal` em ~563 e ~572) precisam ler o contador.

## 3. `getSessions` faz um RPC por sessão, em série

`host/features/terminal/handlers/SessionHandler.ts` (~linha 265):

```ts
for (const [id, session] of sessions) {
  const liveCwd = await daemonClient.getSessionCwd(id);
```

Com 10–20 terminais são 10–20 idas ao daemon em sequência, cada uma com timeout de 5s.
Correção: `Promise.all` sobre as sessões, ou usar o `cwd` que `listSessions` do daemon já devolve.

## 4. Escrita de `sessions.json` a cada prompt

`host/features/terminal/terminalSocket.ts` (~linha 442):

```ts
if (session && cwd && session.cwd !== cwd) { session.cwd = cwd; saveSessionMetadata(sessions); }
```

OSC 7 dispara a cada prompt, então cada `cd` ou comando gera uma escrita síncrona do JSON
inteiro. Correção: debounce de 1–2s em `saveSessionMetadata` para esse caminho, com flush no
shutdown para não perder o último estado.

## 5. Output vai para todos os clientes, de todas as sessões

`host/transport/broadcast.ts` itera todos os peers para cada evento `output`. Um celular com
uma aba aberta recebe o output de todas as sessões e workspaces. Cada `broadcast` ainda passa
por `hasReadyAdapter()` e `_pickAdapter` (que aloca e ordena) mais de uma vez por evento.

Correção: cada socket declara as sessões que assina (`subscribeSession` / `unsubscribeSession`,
ligado à aba visível) e `output` só é emitido para os assinantes. Eventos de status e sidebar
continuam em broadcast. Complemento: cachear o adapter escolhido por canal e invalidar em
`_onAdapterStateChange`.

É o maior ganho em campo, principalmente em mobile e link ruim. Exige mudança coordenada em
host e web (`host/transport/` e `web/shared/transport/` são espelhos).

## 6. Sem backpressure no canal de output

`host/transport/WsProtocol.ts` só checa `_backpressured()` nos canais `binary` e `browser`. O
`output` do terminal, o tráfego mais volumoso, sai por `CHANNELS.control` sem checagem. Em 4G ou
túnel Cloudflare lento, o buffer do engine.io cresce sem limite e o usuário vê output atrasado.

Atenção: **não descartar slices de `output`**. O xterm depende de todos os bytes para manter o
estado (sequências ANSI, modos), e descartar corrompe a tela. A recuperação por
`requestGap`/`seqStore` só é segura se o cliente a disparar de forma automática e confiável.

Abordagem recomendada: quando `_backpressured()` for verdadeiro para o peer, acumular no agente
e enviar um único slice maior ao liberar (coalescência sem perda), ou pausar a leitura do PTY
para a sessão (flow control). Medir antes (ver abaixo) para confirmar que o problema aparece.

## Ordem

| Prioridade | Item | Esforço | Ganho |
|---|---|---|---|
| 1 | #1 `StringDecoder` no client | uma linha | corrige acentos quebrados |
| 2 | #2 trim com contador incremental | baixo | elimina cópia de 2MB por chunk |
| 3 | #3 `Promise.all` em `getSessions` | trivial | lista de sessões N vezes mais rápida |
| 4 | #4 debounce de `saveSessionMetadata` | trivial | menos I/O síncrono |
| 5 | #5 assinatura por sessão | médio | menos bytes e CPU por dispositivo |
| 6 | #6 backpressure sem perda | médio | latência e memória em link ruim |

## Como validar

1. **Daemon:** `process.memoryUsage().heapUsed` e contagem de GC durante `yes | head -c 20M`,
   antes e depois do #2.
2. **Agente:** `performance.now()` do início de `daemonClient.on("output")` até o fim do
   `broadcast`, com p50/p99.
3. **Cliente:** tempo até o último byte de um `git log` grande e `getBufferedAmount()` do socket
   em link limitado (para #5 e #6).
