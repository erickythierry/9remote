# Self-hosted via WireGuard (sem Cloudflare, sem 9remote.cc)

Modo opcional em que o host roda sozinho, sem nenhum servidor de terceiros. Ele
serve o web dash, autentica os devices e entrega terminal, desktop e arquivos.
O acesso vem só de dentro de uma VPN (WireGuard), em HTTP puro
(`http://<ip-wg>:2208`).

Tudo fica atrás de uma flag. Sem `NREMOTE_SELF_HOSTED=1` (host) e
`SELF_HOSTED=1` (build do web), o comportamento é idêntico ao upstream, o que
mantém o merge do upstream barato.

## Como funciona

O Worker (Next API + D1 + Durable Object) existe para localizar um host atrás
de NAT cuja URL de túnel muda. Na VPN o endereço é fixo e o host é o próprio
servidor, então o Worker não foi portado:

- **Sessão e pareamento:** o host já guarda chave, devices aprovados e pairing
  em `~/.9remote/`. O código de pareamento passa a ser gerado localmente.
- **Endpoints que o cliente chama:** o host responde `/api/connect`,
  `/api/temp-key/remove` e `/api/webrtc/turn-credentials` (`host/api/selfHosted.js`).
- **Transporte:** só WS (Socket.IO) direto no host. Não há signaling via DO,
  e o WebRTC não funciona em HTTP fora de localhost (ver Limitações).

## Uso

### 1. Build do web (uma vez, e a cada atualização)

```bash
npm install
SELF_HOSTED=1 node scripts/buildWebStatic.mjs   # gera web/out, servido pelo host
SELF_HOSTED=1 npm run host:build                # dist do comando 9remote; sem a flag, rebuilda o web em modo upstream
```

O build self-hosted embute as fontes (Inter, Material Symbols), não inclui o
Google Analytics nem chama `api.github.com`, e não usa `9remote.cc`.

### 2. Rodar o host

```bash
NREMOTE_SELF_HOSTED=1 \
NREMOTE_TRUSTED_CIDRS=10.8.0.0/24 \
NREMOTE_PUBLIC_ORIGIN=http://10.8.0.2:2208 \
node host/cli/index.js ui        # ou: tui
```

| Variável | Função |
|---|---|
| `NREMOTE_SELF_HOSTED=1` | Liga o modo. Desliga cloudflared, Worker, DO, heartbeat e auto-update via npm. |
| `NREMOTE_TRUSTED_CIDRS` | Faixas (separadas por vírgula) que podem abrir conexão. Fora delas e do loopback, o TCP é derrubado no accept. Entrada malformada derruba o boot. |
| `NREMOTE_PUBLIC_ORIGIN` | Endereço que os clientes usam para chegar ao host. Vai no QR code e no link do dash. |

O host escuta em todas as interfaces, porque a CLI fala com ele por
`127.0.0.1`, mas só aceita peers de loopback e de `TRUSTED_CIDRS`.

### 3. Conectar pelo celular/notebook na VPN

Abra `http://10.8.0.2:2208/login` e entre com a chave permanente ou escaneie o
QR do dash. O host pede aprovação do device (TUI ou dash em
`http://127.0.0.1:2208`). Depois de aprovado, o workspace abre.

## O que cada mudança faz

### Host

| Mudança | Onde |
|---|---|
| Flags `SELF_HOSTED`, `PUBLIC_ORIGIN`, `TRUSTED_CIDRS`; `WORKER_URL` vira o próprio host | `host/cli/config.js` |
| `remoteEnabled` fixo em `false`; todos os caminhos de Worker/túnel/DO já dependem dele | `host/cli/utils/state.js` (`loadSettings`) |
| Bloqueia ligar o remote; `GET` responde `enabled: true, selfHosted: true` para o dash | `host/api/remote.js` |
| Heartbeat/goodbye no Worker vira no-op | `host/cli/tunnel/urlSync.js` (`postHeartbeat`) |
| `cloudflared` nunca é baixado nem executado | `host/cli/utils/cloudflared.js` (`ensureCloudflared`) |
| Signaling DO nunca inicia | `host/lib/signalingGlobal.js` (`initSignalingGlobal`) |
| Código de pareamento gerado localmente; `registerSession` vira no-op | `host/cli/utils/token.js` |
| Gerar código e regenerar chave liberados mesmo com remote off | `host/api/key.js`, `host/cli/core/cmdPoller.js` |
| Boot em READY com `tunnelUrl = PUBLIC_ORIGIN`, mostra QR e menu Keys | `host/cli/modes/tui.js`, `ui.js`, `auto.js` |
| Auto-update via npm desligado | `host/index.js` (`checkForUpdate`) |
| Filtro TCP: só loopback e `TRUSTED_CIDRS` | `host/index.js`, `host/lib/trustedNetwork.js` |
| Rotas `/api/connect`, `/api/temp-key/remove`, `/api/webrtc/turn-credentials` | `host/api/selfHosted.js`, tabela em `host/index.js` |
| Export web (`/login`, `/workspace`, `/_next`, assets) público para a VPN; host UI, `/admin` e `/api/*` privados seguem só loopback | `host/lib/router.js` (`publicFallback`), `isPublicWebAsset` em `host/index.js` |
| Peer da VPN passa o gate de "remote off", depois enfrenta tail proof e aprovação manual | `host/transport/server.js` |

### Web (só com `SELF_HOSTED=1` no build)

| Mudança | Onde |
|---|---|
| `NEXT_PUBLIC_SELF_HOSTED=1`, sem `WORKER_URL`, sem GA | `web/next.config.mjs` |
| Fontes locais (`@fontsource/inter`, `material-symbols`) e imagens do `flagcdn` escondidas, via alias `@app-fonts` | `web/app/fonts.local.css`, `fonts.remote.css`, `layout.js`, `globals.css` |
| `isHostMachine()` separado: só loopback/Tauri chamam as APIs de loopback do host (`/api/ui/*`, `/api/device/*`, SSE); `isHostEnvironment` vira alias dele | `web/shared/utils/localOrigin.js`; call sites em `PendingDeviceApprovalModal.js`, `AgentDashboardView.js`, `SessionList.js` |
| Login em origem não-loopback vai por `/api/connect` no próprio host, com as chaves do host para selar o tail | `web/shared/hooks/useAuth.js` |
| Perfil de transporte só WS | `web/shared/transport/lib/pmConfig.js` |
| Links do dash apontam para o host, não para `9remote.cc` | `web/shared/constants/API.js`, `AgentDashboardView.js` |
| Contador de estrelas do GitHub desligado | `web/shared/hooks/useGithubStars.js` |
| STUN externo (Google, Twilio, Cloudflare) fora do default: `DEFAULT_ICE_SERVERS` e `STUN_PROBE.urls` vazios; o probe de IP público não dispara | `web/shared/constants/transport.js`, `WebRtcProtocol.js`, `stunProbe.js` |
| Sem link para `docs.9remote.cc`: `DOCS_URL` vazio, Navbar/Footer escondem o item | `web/shared/constants/API.js`, `web/features/landing/components/Navbar.js`, `Footer.js` |

## Segurança

- HTTP em texto puro só é aceitável porque o WireGuard cifra o enlace. Não
  exponha a porta na LAN física nem na internet: use firewall na `wg0` e
  mantenha `TRUSTED_CIDRS` restrito à sub-rede da VPN.
- O tail da chave tem poucos caracteres. O que protege de verdade é a
  aprovação manual de device. Não ligue auto-approve para a VPN.
- As APIs de controle do host (`/api/ui/state` expõe a chave permanente)
  continuam só loopback. `isLoopbackSocket`, `LOCAL_UI_ORIGINS`, `pathGuard.js`
  e o guard de Host/Origin do router não mudaram.
- `/api/connect` usa o mesmo contador de penalidade das provas de tail, então
  adivinhar o HEAD não fica mais barato por essa porta.

## Limitações

- **Sem contexto seguro** (HTTP fora de localhost), o browser remove
  `crypto.subtle`, clipboard, Service Worker e push. O tail vai sem selo (a VPN
  cifra) e não há WebRTC, então o desktop remoto também vai por WS. No Chrome
  do Android, `chrome://flags/#unsafely-treat-insecure-origin-as-secure` com o
  endereço do host devolve essas APIs, por device.
- Códigos de pareamento já resgatados ficam marcados só em memória: reiniciar o
  host esquece a marcação, mas a janela de 10 minutos do código continua
  valendo.
- O app nativo Android/iOS não está no repo (`.gitignore`: movido para
  `decolua/9remote-expo`, privado) e aponta para `9remote.cc`. O cliente aqui é
  o navegador ("Adicionar à tela inicial").
- Um dash por host. Com vários PCs, cada um serve o seu.
- O título `9remote.cc` no cabeçalho do workspace vem das strings de i18n e é
  só texto.

## Verificado

Testei com o host isolado (porta 2299, `NREMOTE_HOME` temporário). O IP da LAN fez o papel da faixa da VPN, e o Chrome headless fez o papel de cliente:

- Login com a chave e por QR, aprovação manual e abertura do workspace.
- Terminal: um comando enviado via WS foi executado no PTY.
- Desktop remoto: o canvas 1920x1080 desenhou a tela real capturada, com o carrier `WS · LOCAL`.
- File explorer: listagem e leitura ok; `/etc/shadow` negado pelo `pathGuard`.
- Nenhum desses fluxos fez requisição para fora do host.
- Um IP fora de `TRUSTED_CIDRS` tem a conexão TCP derrubada. Pela VPN, o host UI, o `/admin` e as `/api/*` privadas respondem 403.
- Sem as flags, o host e o build web ficam iguais ao upstream.

- Túnel WireGuard real, sem root: user namespace com o uid real (`unshare --map-current-user -n`) e dois netns ligados por veth (host `10.8.0.2`, celular `10.8.0.5`). Chrome headless rodou no netns do celular e fez login, aprovação e desktop remoto pelo `wg0`. O acesso ao host pelo IP de fora do túnel teve a conexão derrubada.
- Bundle do build self-hosted sem `stun:`, `fonts.googleapis`, GA nem `trycloudflare`.

Não verificado: o modo `tui` interativo (os modos `ui`, `auto` e o server foram exercitados) e um celular físico.

## Testes

```bash
cd host
node --test test/trustedNetwork.test.mjs test/routerPublicFallback.test.mjs \
  test/routerOrigin.test.mjs test/admissionGate.test.mjs test/admissionFlowE2e.test.mjs
```
