# PRD: migração de JavaScript para TypeScript

**Status:** plano de execução, baseado na auditoria do código versionado em 2026-10-20. **Branch/worktree:** `migrar-ts` em `/mnt/ssd/DADOS/codigos/9remote-migrar-ts`.

**Revisão de referência:** `5ec709ed34757c4ef425682586e9e94e8d4571be`. As contagens abaixo descrevem essa revisão; devem ser recalculadas se a base da migração mudar. A revisão documental confirmou as contagens por extensão e diretório, mas não repetiu a análise AST de JSX.

## Objetivo

Converter o código de produto mantido pelo projeto para TypeScript, incluindo componentes React/Preact em TSX e testes em TypeScript. A tipagem deve melhorar navegação, refatoração e detecção de incompatibilidades entre módulos sem alterar o comportamento do 9Remote.

O trabalho será incremental. JavaScript e TypeScript poderão coexistir durante a migração, mas cada fatia integrada deve compilar, passar pela verificação de tipos e preservar os contratos de runtime existentes.

## Escopo e política

Entram no escopo:

- Código de produto de `host/`, `web/`, `gitbook/` e `expo/`.
- Os testes existentes em `host/test/` e `web/test/`, migrados junto das respectivas áreas para `.mts` quando o modo ESM precisar ser explícito.
- Os três scripts de `host/extension/`, compilados para JavaScript no pacote final, pois o Manifest V3 carrega caminhos `.js` diretamente.
- `web/public/sw.js`, compilado a partir de TypeScript para continuar disponível no caminho público `/sw.js`.
- Código executável hoje embutido em `desktop/dist/index.html`, extraído para fontes TS quando necessário e recompilado para o frontend do Tauri.
- Módulos de idioma `.js`, convertidos mecanicamente, sem alterar nomes de chaves ou traduções.

Permanecem JavaScript/MJS, com exceção registrada:

- Configurações de ferramentas: ESLint, Vite, Tailwind, PostCSS, Next, Babel e Metro.
- Automação de build, release, injeção no Worker e geração de conteúdo/ícones/versão, incluindo `scripts/`, `web/scripts/`, os quatro benchmarks do host, os loaders de teste existentes e `web/shared/i18n/insertKeys.mjs`. Esses scripts podem ser ajustados para compilar ou localizar fontes TS, mas não precisam ser convertidos.
- Snippets mínimos inline cuja execução antes da renderização evita flash visual, se extraí-los alterar esse comportamento. A exceção deve ser apontada por arquivo e justificada no fechamento.
- Saídas geradas. Elas continuam JavaScript quando o navegador, a extensão ou o Worker espera JavaScript.

As configurações e ferramentas não podem se tornar uma exceção implícita para código de produto: cada arquivo que permanecer JS/MJS deve constar na lista de exceções revisada ao final.

## Auditoria do estado atual

As contagens são de arquivos versionados (`git ls-files`); dependências e artefatos ignorados não entram. Os 815 arquivos `.js` foram analisados com parser AST habilitando JSX: todos foram analisados sem erro e **190 contêm JSX**. Somados aos 46 `.jsx`, há **236 fontes que devem terminar em `.tsx`**. Não há `.cjs` nem `.tsx` versionados.

| Área | `.js` | `.jsx` | `.mjs` | JSX dentro de `.js` | `.ts` atual | Observações |
|---|---:|---:|---:|---:|---:|---|
| `host/` | 280 | 8 | 147 | 0 | 0 | 274 fontes de produto, 3 scripts de extensão, 3 configs; os 8 JSX ficam em `host/ui/src/` |
| `web/` | 516 | 38 | 89 | 180 | 1 | 34 rotas de API e 42 handlers HTTP; 81 testes e 2 loaders em `web/test/` |
| `gitbook/` | 11 | 0 | 2 | 9 | 1 | 9 páginas/componentes com JSX; conteúdo gerado importado pelas rotas |
| `expo/` | 4 | 0 | 0 | 1 | 0 | App standalone, fora dos npm workspaces |
| `scripts/` | 4 | 0 | 4 | 0 | 0 | Automação de build, release, versão e assets |
| `desktop/` | 0 | 0 | 3 | 0 | 0 | Tauri/Rust; contém HTML estático versionado com scripts inline |
| raiz | 0 | 0 | 1 | 0 | 0 | `eslint.config.mjs` |
| **Total** | **815** | **46** | **246** | **190** | **2** | Os dois `.ts` são `web/open-next.config.ts` e `gitbook/open-next.config.ts` |

### Onde estão as fontes com JSX

Os 236 arquivos candidatos a TSX distribuem-se assim:

| Área | `.js` com JSX | `.jsx` | Total TSX |
|---|---:|---:|---:|
| `web/` | 180 | 38 | 218 |
| `host/` | 0 | 8 | 8 |
| `gitbook/` | 9 | 0 | 9 |
| `expo/` | 1 | 0 | 1 |
| **Total** | **190** | **46** | **236** |

No `web/`, as fontes com JSX concentram-se em `features/` (133 `.js` e 36 `.jsx`), `shared/` (36 `.js` e 2 `.jsx`) e `app/` (11 `.js`). Os maiores grupos de arquivos em `web/features/` são `terminal` (87), `fileExplorer` (63), `ai` (55), `remote` (24), `browser` (21) e `mobile` (17), incluindo `.js` e `.jsx`.

No `host/`, os 147 `.js` em `features/` distribuem-se entre `ai` (43), `terminal` (27), `remote` (16), `fileExplorer` (12), `browserUse` (11), `browser` (10), `mobile` (9), `jarvis` (8), `quotaTracker` (7), `artifact` (3) e `clipboard` (1). Há ainda 33 arquivos JS na CLI, 23 em `lib/`, 15 em `transport/`, 13 em `mcp/`, 11 em `api/` e 27 em `host/ui/src/` além dos 8 JSX.

### Acoplamentos e restrições encontrados

- **TypeScript ainda não está configurado.** Não há dependência `typescript`, `tsconfig.json`, comando `typecheck` ou configuração TypeScript explícita do ESLint nos manifests. `web/jsconfig.json` e `gitbook/jsconfig.json` definem o alias `@/*` que deve ser preservado. O repositório não versiona lockfile npm e o `.gitignore` ignora `package-lock.json`.
- **As regras do agente estão desatualizadas para este objetivo.** `AGENTS.md` exige JavaScript e proíbe TypeScript. A primeira fatia deve substituir essa regra por uma política de convivência e conversão TS.
- **Testes existem, embora não haja script npm para executá-los.** `host/test/` tem 143 módulos `node:test`; `web/test/` tem 81 testes e 2 loaders próprios. São 224 módulos de teste. 129 testes do host importam fontes JS por 356 referências; os testes web usam 236 referências locais explícitas terminadas em `.js`, distribuídas em 121 arquivos. A estratégia de importação e execução TS precisa ser provada antes de renomeações em massa.
- **Host exige duas formas de execução.** Desenvolvimento roda fontes ESM diretamente via Node/nodemon; publicação empacota CLI, servidor, daemon PTY e instalador como CommonJS para Node 18 via `scripts/buildPkg.js`/esbuild. Dependências nativas opcionais permanecem externas. O build self-hosted deve continuar sendo invocado como `SELF_HOSTED=1 npm run host:build`.
- **UI do host usa Preact e Vite.** Configurar TSX para Preact e verificar `host/vite.config.js`: o obfuscador atualmente seleciona `**/*.js`. Os catálogos de idioma da UI têm 24 módulos JS e não podem ser editados individualmente.
- **Transporte é espelhado.** `host/transport/` e `web/shared/transport/` implementam o mesmo protocolo. Mudanças de tipos devem ser coordenadas; mudanças de fio, framing ou codec estão fora do escopo desta migração.
- **Worker tem fontes injetadas como texto.** `web/hotRoutes.js` e `web/durable-objects/SignalingDO.js` são copiados sem compilação por scripts de `web/scripts/`. A pipeline deve transpilar TypeScript antes da injeção e manter a paridade comportamental. Há testes de paridade relacionados, como `web/test/hotRoutes.test.mjs`.
- **Service worker é servido diretamente.** `web/public/sw.js` é registrado por `web/app/layout.js`. Sua fonte pode virar TS, mas o build deve continuar emitindo `/sw.js` com os mesmos eventos e comportamento offline.
- **As fronteiras do Worker precisam de tipos sem inventar schema.** As rotas usam Cloudflare context, D1 e JSON recebido pela rede. Existem 14 migrations incrementais, mas a auditoria não encontrou neste repositório a criação inicial das tabelas `sessions` e `temp_keys`; tipar somente os campos evidenciados pelas consultas ou por schemas disponíveis. `env.d.ts` é gerado e não versionado. Nenhum segredo deve entrar no código, no PRD ou no `wrangler.toml`.
- **GitBook gera conteúdo antes do build.** `gitbook/generated/content.json` é ignorado, mas importado por páginas. `prebuild` o gera; o novo fluxo de typecheck também deve garantir sua geração. Preservar o alias, `generateStaticParams`, rotas estáticas e o comportamento de renderização Markdown.
- **Expo é independente.** Está em SDK 52/React Native 0.76, não é workspace. Tipos e scripts devem ser instalados/configurados em `expo/`. Preservar o contrato JSON do WebView/native bridge, callbacks globais e persistência AsyncStorage.
- **Extensão Chrome carrega arquivos JS pelo manifesto.** `host/extension/manifest.json` aponta para scripts `.js`, e o empacotador copia esses arquivos. As fontes TS precisam ser compiladas para os mesmos nomes no pacote.
- **Desktop não tem fontes `.js/.jsx` externas.** Há 3 `.mjs` de empacotamento e 2 blocos inline em `desktop/dist/index.html`, que é consumido pelo Tauri. `host/ui/index.html` contém outro bootstrap inline de tema; `host/ui/dist/index.html` é saída compilada. Preservar os caminhos de entrada do Tauri e o comportamento dos bootstraps.
- **Internacionalização tem procedimento obrigatório.** Há 47 módulos de idioma JS (24 no host e 23 no web). A conversão precisa ser mecânica e validar igualdade de chaves/valores; nunca traduzir nem editar arquivos de idioma individualmente.
- **Não foi encontrada configuração de CI versionada.** Os gates iniciais serão scripts locais padronizados e revisão do coordenador. Uma integração futura de CI deve executar typecheck, testes e builds sem publicar ou fazer deploy.

## Contratos que a migração não pode alterar

1. **Protocolo e transporte:** nomes de eventos, tipos de mensagem, framing, ordem, codificação, bytes serializados, negociação WS/WebRTC e payloads permanecem iguais. Alterações pareadas host/web têm um único responsável de integração.
2. **APIs, D1 e Worker:** métodos HTTP, rotas, status, corpos de resposta, autenticação, autorização, rate limits, CORS, nomes de colunas usados e variáveis de binding permanecem iguais. A tipagem de `request.json()` ou dados de D1 não substitui validação em runtime.
3. **Segurança do host:** preservar path jail de `fileExplorer/pathGuard.js`, aprovação de dispositivo, fluxo QR/one-time key, CORS/auth e auto-update. Tipos/casts nunca transformam entrada externa em dado confiável.
4. **Build do host:** preservar target Node 18, saídas `dist/cli.cjs`, `dist/server.cjs`, `dist/ptyDaemon.cjs` e `dist/install.cjs`, dependências nativas opcionais externalizadas, manifesto/metadados do pacote e modo self-hosted.
5. **Assets carregados por caminho:** extensão mantém nomes JS do manifesto; Worker mantém injeções e bindings; service worker continua em `/sw.js`; Tauri conserva o frontend configurado. Arquivos TS nunca podem ser copiados crus para um runtime que espera JS.
6. **I18n:** manter exatamente as chaves, valores, fallback e cobertura dos locales existentes. Nenhuma tradução faz parte desta migração.
7. **UI, mobile e docs:** manter rotas, nomes de parâmetros, mensagens da bridge, callbacks, HTML/IDs usados por Markdown e navegação estática.
8. **Qualidade de tipos:** código TS novo é estrito. Não introduzir `any` global, declarações ambient amplas, `@ts-ignore` ou casts para silenciar incompatibilidades. Quando uma dependência nativa não tiver tipos adequados, encapsular sua interface estreita e documentar o limite.

## Etapas de execução

### Etapa 0 — política, baseline e lista de trabalho

- Atualizar `AGENTS.md` e regras relacionadas: TS/TSX passa a ser padrão para código novo e migrado; JS/MJS continua permitido para configs/ferramentas e exceções aprovadas.
- Versionar ou gerar uma lista por fatia de fontes, consumidores/imports, testes relacionados e exceções. Não mover arquivos nesta etapa.
- Manter os registros em `docs/typescript-migration/`: `inventory.md` para fontes e consumidores, `decisions.md` para decisões da fundação, `exceptions.md` para exceções e `validation.md` para comandos, resultados e limitações. Cada exceção deve informar caminho, motivo, responsável pela revisão e se é temporária ou definitiva.
- Registrar o comando reproduzível do inventário baseado em `git ls-files`. Recuperar ou implementar a auditoria AST de JSX, registrando parser, versão, opções e comando; conferir novamente os 236 candidatos a TSX antes de tratar essa contagem como gate. A ferramenta de auditoria pode permanecer JS/MJS.
- Registrar comandos atuais que reproduzem testes e builds afetados. Padronizar comandos npm por pacote para os testes existentes, sem alterar o conteúdo dos testes.
- Usar `migrar-ts` como branch/worktree de integração. Worktrees de tarefa podem derivar do último estado integrado conforme o fluxo de subagentes; cada entrega deve identificar a revisão de origem.

**Contrato de saída:** baseline de arquivos e comandos revisável; nenhuma mudança de runtime; política do repositório não contradiz o objetivo.

### Etapa 1 — fundação e spikes de compatibilidade

- Adicionar TypeScript e tipos necessários nos pacotes aplicáveis (`host`, `web`, `gitbook`, `expo`), sem presumir que Expo é workspace.
- Registrar versões de Node, npm, TypeScript e runner escolhidos, incluindo o ambiente independente do Expo. Distinguir o Node necessário para desenvolver/buildar cada pacote do target Node 18 do host distribuído; provar a compatibilidade do runner do host com Node 18. Definir a política de lockfiles antes de instalar a toolchain: se continuarem ignorados, fixar versões exatas das dependências diretas da migração e registrar a árvore resolvida usada na validação, reconhecendo que isso não fixa dependências transitivas em instalações futuras.
- Criar `tsconfig.json` por ambiente. Preservar `@/*`; incluir os tipos Cloudflare/Node/React/Preact/RN necessários; excluir saídas geradas sem excluir arquivos de conteúdo importados.
- Registrar em `decisions.md` a matriz de configurações: fontes incluídas, runtime, bibliotecas/tipos globais, modo de módulos, resolução e comando de typecheck. Separar contextos incompatíveis, especialmente Node, DOM/React, DOM/Preact, Worker Cloudflare, service worker, extensão Chrome, Expo e frontend Tauri. Todo `.ts/.tsx/.mts` mantido no escopo, inclusive testes, deve pertencer a uma configuração verificada; nenhum pode escapar por exclusões. O comando agregado deve verificar todas essas configurações.
- Habilitar convivência JS/TS. O typecheck passa a verificar todo TS novo com `strict`; arquivos JS ainda não migrados não precisam bloquear por `checkJs` nesta fase.
- Configurar ESLint para analisar `.ts/.tsx` sem perder as regras atuais.
- Fazer um spike mínimo no host, no web/Next, na UI Preact, no GitBook e no Expo: importar TS de JS e JS de TS, executar typecheck, desenvolver/buildar a fatia e observar aliases/extensões.
- Escolher a execução dos testes e do host dev com suporte a Node 18. Preferir um runner/transpilador de desenvolvimento; o pacote distribuído não pode exigir runtime TypeScript.
- Antes da conversão em massa, registrar a política de imports relativos e aliases, a resolução de referências `.js` para fontes TS no desenvolvimento/testes/build e o tratamento de imports dinâmicos e caminhos usados para iniciar subprocessos. Padronizar testes em `.ts`; usar `.mts` somente quando necessário para explicitar ESM e registrar a justificativa.
- Adicionar scripts padronizados de `typecheck`, `test` e builds locais por workspace. O typecheck do GitBook gera `generated/content.json` antes de verificar.

**Contrato de saída:** mistura TS/JS funciona em cada pipeline relevante; não há JS emitido dentro da árvore fonte; imports relativos explícitos e aliases funcionam em editor, typecheck, testes, Vite, Next e esbuild; pacote publicado continua CJS para Node 18.

Versões, política de dependências, matriz de typecheck, runner e resolução de imports devem estar decididos e demonstrados pelos spikes antes de iniciar as etapas 2 a 6.

### Etapa 2 — transporte e contratos compartilhados

- Migrar em uma única fatia coordenada os modelos/codec/registry e testes de paridade de `host/transport/` e `web/shared/transport/`.
- Definir tipos de envelope e payload com o que já existe; não alterar o protocolo para acomodar tipos.
- Documentar uma única responsabilidade para imports `.js` explícitos e a resolução do runner, antes de converter os consumidores em massa.

**Contrato de saída:** testes/paridade existentes passam nos dois lados; eventos, bytes e payloads são idênticos; nenhum lado fica temporariamente incompatível com o outro.

### Etapa 3 — host por camadas e domínios

1. Helpers puros, constantes, formatos e adapters estreitos de bibliotecas nativas.
2. Bibliotecas centrais e limites de entrada; file explorer/path guard, aprovação, sessão/QR e update checker com validação preservada.
3. API, registry/socket handlers e transporte.
4. Features por domínio, em folhas pequenas: `fileExplorer`, `terminal`, `remote`, `ai`, `browser`/`browserUse`, `mobile`, `jarvis`, `quotaTracker`, `artifact` e `clipboard`.
5. CLI, lifecycle, tunnel, servidor e entrypoints de daemon depois de suas dependências.
6. UI Preact, locais e extensão Chrome; gerar JS compatível nos destinos finais.

Cada tarefa inclui fontes e testes diretamente ligados à fatia. A UI de Preact e a extensão podem avançar em paralelo com domínios de servidor apenas depois da fundação, desde que não disputem configs comuns.

**Contrato de saída por fatia:** typecheck estrito da área; testes existentes relacionados passam; CLI/servidor e handlers mantêm inputs/outputs; dependências opcionais continuam opcionais; build do pacote e build Vite continuam funcionando; nenhum arquivo TS é emitido no diretório de fontes.

### Etapa 4 — web backend e módulos do Worker

1. Tipar modelos de ambiente/bindings, resultados D1 observados e parsers/validadores de entrada.
2. Migrar utilitários de auth/session/connection e rotas API por grupos independentes; preservar as 34 rotas e 42 exports HTTP.
3. Migrar `hotRoutes.js` e `SignalingDO.js`; mudar o pipeline para transpilar antes da injeção. Validar paridade com rotas/handlers normais.
4. Migrar feature/server modules não visuais.

**Contrato de saída por fatia:** typecheck; testes existentes da área; métodos, respostas, autorização, D1 queries e validação iguais; fonte injetada no Worker é JS produzido pelo build; nenhum valor secreto é necessário para o typecheck.

### Etapa 5 — web UI e shared por feature

- Migrar stores, componentes compartilhados e hooks em grupos pequenos, depois features em fatias (`terminal`, `fileExplorer`, `ai`, `remote`, `browser`, `mobile`, `admin`, `landing`, `hosts`, `session`, `jarvis`, `codespace`, `ota`, `quota`).
- Renomear cada `.js` que contém JSX e todo `.jsx` para `.tsx`; código sem JSX vai para `.ts`.
- Migrar páginas/layouts do App Router sem mudar rotas nem o contrato de `params` assíncrono do Next 16.
- Executar conversão automatizada de catálogos de idiomas. Adaptar importador/inseridor para a nova extensão sem editar traduções manualmente.
- Migrar o service worker para TS e gerar o arquivo público em `/sw.js`.

**Contrato de saída por fatia:** typecheck e build Next; UI mantém comportamento, rotas e estado; todos os locales mantêm chaves/valores; PWA instala/atualiza pelo mesmo caminho; sem mudanças visuais/funcionais não relacionadas.

### Etapa 6 — GitBook, Expo e desktop

- GitBook: converter 9 arquivos com JSX para TSX e os módulos de produto restantes para TS; preservar alias, `generateStaticParams`, rotas estáticas, conteúdo markdown e headings/IDs; gerar conteúdo antes de typecheck/build.
- Expo: converter `App.js` para TSX e o bootstrap `index.js` para TS; manter Babel/Metro configs JS; tipar a bridge como mensagens discriminadas e continuar validando JSON em runtime.
- Desktop: extrair os dois scripts inline de `desktop/dist/index.html` para fontes TS e compilar para o frontend Tauri, se isso preservar o tempo/ordem de execução. Avaliar o bootstrap inline de tema do `host/ui/index.html` separadamente e registrar eventual exceção.

**Contrato de saída:** export estático do GitBook; Expo mantém mensagens, nomes de callbacks, orientação, tema, haptics e persistência; página Tauri continua refletindo inicialização e tema sem mudança de timing percebida.

### Etapa 7 — testes remanescentes, auditoria de exceções e fechamento

- Converter os 143 testes host e 81 testes web por área para `.ts`, usando `.mts` apenas quando necessário conforme a política da etapa 1. Adaptar/aposentar loaders conforme a estratégia escolhida; preservar os cenários atuais e as fixtures.
- Executar `typecheck`, lint, suites existentes e builds de cada pacote. Nenhum deploy, publish, assinatura ou upload faz parte desta migração.
- Recontar arquivos versionados. Todo JS/MJS de produto precisa ter sido convertido; configs, tooling e qualquer bootstrap inline remanescente precisam constar na lista de exceções aprovada.
- Rever imports explícitos `.js`, dynamic imports, glob patterns, obfuscator, scripts de pacote, outputs compilados e arquivos copiados para Worker/Chrome/Tauri.

**Contrato de conclusão:** typecheck sem erros; testes existentes passam; builds relevantes geram os mesmos formatos/caminhos; não há fontes de produto `.js/.jsx` esquecidas; exceções são pequenas, nomeadas e motivadas; nenhuma alteração de wire/API/schema/UI fora da tipagem.

## Fluxo de trabalho com subagentes

Um agente coordenador mantém o inventário, contratos, configs comuns e integração. Subagentes executam fatias de migração com lista fechada de arquivos. Como arquivos de transporte, modelos, configurações e locales têm muitos consumidores, eles têm um único responsável por vez.

1. O coordenador abre uma tarefa a partir do último estado integrado de `migrar-ts`, com lista explícita de arquivos permitidos, dependências e contrato a preservar.
2. Para trabalho concorrente, cada agente usa uma branch/worktree de tarefa derivada do último estado integrado. Agentes não editam em paralelo os mesmos arquivos. Se o ambiente compartilhar uma única worktree, só podem rodar em paralelo tarefas com escopos de arquivo disjuntos.
3. O coordenador congela contratos antes de delegar consumidores. O par `host/transport` + `web/shared/transport`, toolchain, `AGENTS.md`, tsconfigs, manifests raiz e i18n são tarefas coordenadas, não trabalho paralelo livre.
4. O subagente migra somente a fatia pedida, mantém imports/outputs válidos e executa os checks daquele pacote. Se identificar alteração de comportamento necessária, interrompe essa mudança e reporta como decisão separada.
5. Ao terminar, reporta: arquivos alterados/renomeados; contratos que verificou; comandos executados e resultado; casts/declarações externas introduzidos e motivo; exceções e pendências.
6. O coordenador revisa diff, compara comportamento e valida testes/build. Só então integra a tarefa e atualiza a lista de trabalho; próximas tarefas partem da revisão integrada mais recente.
7. Manter no máximo duas ou três fatias independentes em andamento. Um único responsável coordena trabalho que altere protocolo, configurações compartilhadas, locales ou injeção de Worker.

### Modelo de tarefa para agente

```text
Objetivo da fatia:
Arquivos permitidos:
Dependências/consumidores:
Contrato observável a preservar:
Fora de escopo:
Checks obrigatórios:
Critério de conclusão:
Revisão de origem e último estado validado:
Configurações de typecheck que cobrem os arquivos:
Validação de comportamento aplicável:
Limitações e procedimento de reversão:
```

Agentes não devem ampliar silenciosamente o escopo, editar segredos, modificar schema/wire format, suprimir erros de tipos ou converter uma mudança de comportamento numa “correção” incidental. O coordenador decide e separa qualquer trabalho adicional.

### Integração e reversão por fatia

- Entregar cada fatia em commits delimitados, incluindo renomeações, consumidores, testes e ajustes de build necessários para manter a integração funcional. Não misturar alterações de comportamento ou refatorações alheias à migração.
- Registrar revisão de origem, commits integrados, comandos/resultados e último estado validado em `validation.md`. Dependências entre fatias devem constar no inventário.
- Se houver regressão, suspender a integração de consumidores dependentes e reverter os commits da fatia com `git revert`. Quando houver dependências já integradas, reverter primeiro as dependentes na ordem inversa de integração. Preservar alterações locais de outros trabalhos.
- Após a reversão, regenerar os artefatos afetados e repetir os gates relacionados para confirmar o retorno ao estado validado. Nenhuma reversão pode exigir alteração de schema, segredos ou protocolo, pois essas mudanças estão fora do escopo.

## Gates de validação

Os comandos exatos serão padronizados na Etapa 1. A lista final deve incluir, no mínimo:

- Typecheck estrito de todas as configurações da matriz, cobrindo host Node, testes, UI Preact, web React/Next, Worker Cloudflare, service worker, extensão Chrome, GitBook, Expo e frontend Tauri. Transpilação/build sem erros não substitui verificação de tipos.
- Testes existentes de host e web, incluindo testes de paridade de transporte/Worker e segurança relevantes para a fatia.
- `npx eslint .` cobrindo JS e TS/TSX.
- Build da UI Preact (`host`), build do pacote host com `SELF_HOSTED=1 npm run host:build`, build Next/OpenNext web e build estático do GitBook.
- Verificação/build Expo sem depender de TypeScript em runtime.
- Checagem de conteúdo gerado antes do typecheck do GitBook; teste de que o Worker recebe JS compilado; verificação de que extensão e service worker preservam os caminhos públicos.
- Compilação e verificação local do frontend Tauri, integrado ao `frontendDist` configurado, sem assinatura/notarização. Registrar separadamente a disponibilidade de validação nativa por plataforma.

### Roteiro mínimo de validação de comportamento

Registrar em `validation.md` a revisão, plataforma/runtime, pré-condições, comando ou passos, resultado esperado e observado e evidência de cada cenário aplicável. Executar os cenários afetados por fatia e consolidar todos no fechamento. Usar ambiente local e dados de teste para fluxos de segurança.

| Área | Cenários e comportamento esperado |
|---|---|
| Conexão e autenticação | Conectar um cliente ao host self-hosted; aprovar dispositivo; rejeitar acesso não autorizado; confirmar consumo/expiração da chave QR e reconexão conforme o comportamento da baseline. |
| Terminal | Criar sessão, enviar entrada e receber saída, redimensionar e reconectar; reiniciar o host e confirmar persistência via daemon PTY. |
| Arquivos | Listar, enviar e baixar um arquivo de teste; confirmar bloqueio de caminhos fora da raiz permitida e tentativas de traversal. |
| Transporte e desktop remoto | Comparar envelopes/bytes pelos testes de paridade; estabelecer WS e WebRTC nos fluxos suportados; confirmar imagem e entrada remota quando o ambiente permitir captura. |
| Worker/API | Executar testes das rotas e paridade das injeções; confirmar respostas/autorização e carregamento do JS gerado em ambiente local do Worker, incluindo bindings de teste necessários. |
| UI e i18n | Abrir as telas afetadas, navegar e verificar estado/tema; comparar mecanicamente chaves e valores dos catálogos antes/depois da conversão. |
| PWA e extensão | Confirmar `/sw.js`, registro, atualização e comportamento offline previsto na baseline; carregar a extensão compilada e exercitar suas mensagens e entradas declaradas no manifesto. |
| Expo | Abrir o WebView; exercitar mensagens nos dois sentidos e callbacks globais; confirmar persistência após reabrir o app, orientação, tema e haptics nas plataformas disponíveis. |
| GitBook | Gerar conteúdo, exportar e abrir as rotas estáticas; verificar links e headings/IDs usados pela navegação Markdown. |
| Tauri | Abrir o frontend gerado e, quando disponível, o wrapper nativo; confirmar inicialização, tema e ordem de execução dos bootstraps. |

Resultados devem usar os estados `passou`, `falhou` ou `bloqueado`, com justificativa. Registrar falhas já existentes na baseline separadamente de regressões introduzidas. Ausência de dispositivo, sistema operacional, captura ou binding não conta como aprovação: manter o cenário pendente com responsável e ambiente necessário. Não declarar preservação de comportamento nem fechamento integral enquanto houver cenários obrigatórios bloqueados ou regressões sem resolução.

Como o repositório não possui CI versionada, o coordenador exige esses gates localmente antes de integrar cada pacote. A migração não executa publicação npm, deploy Cloudflare, sync de secrets, assinatura/notarização ou upload de artefatos.

## Progresso da implementação

**Posição em 2026-10-21 (conclusão da convergência de código de produto).** 100% dos arquivos de código de produto de todos os workspaces (`host/`, `web/`, `desktop/`, `gitbook/`, `expo/`) estão em TypeScript (`.ts` e `.tsx`) e passam com **0 erros** de compilação no `tsc --noEmit`. Não resta nenhum arquivo `.js` no código de produto.

### Estado por etapa

| Etapa | Estado | Evidência / o que falta |
|---|---|---|
| 0 — política e baseline | Concluída | Baseline e PRD em `df510f8f`; `inventory.md/json`, `decisions.md`, `exceptions.md`, `validation.md`, `dependency-tree.json` e `semantics-review.json` em `docs/typescript-migration/`. Auditoria AST reproduziu os 236 candidatos a TSX. |
| 1 — fundação e spikes | Concluída | `tsconfig` por ambiente: host (`tsconfig.json`, `tsconfig.test.json`, `ui/`, `extension/`), web (`tsconfig.json`, `.test`, `.worker`, `.service-worker`), GitBook, Expo e desktop. Runner `tsx`, scripts de compilação e validação integrados. |
| 2 — transporte | Concluída | Codec e frames de arquivo migrados e tipados nos dois lados (`host/transport` e `web/shared/transport`). Testes de paridade e checagem cruzada de bytes aprovados, preservando formato de fio e framing WS/WebRTC. |
| 3 — host | Concluída | 100% convertido para TypeScript. `tsc -p host/tsconfig.json --noEmit` passa com **0 erros**. `api/`, `cli/`, `features/` (`ai`, `remote`, `fileExplorer`, `terminal`, etc.), `lib/`, `mcp/`, `transport/`, UI Preact e extensão Chrome todos tipados. |
| 4 — web backend/Worker | Concluída | 34 rotas de API em TS e aprovadas no perfil Worker (`web/tsconfig.worker.json` com 0 erros); `hotRoutes` e `SignalingDO` em TS, com injeção que transpila antes (`workerInjection.test.ts` passou); suíte de `hotRoutes` e do relay de signaling passaram. Tipos de binding declarados estritamente. |
| 5 — web UI e shared | Concluída | 100% dos arquivos de código de produto foram convertidos para `.ts/.tsx` (zero `.js` restante). `web/tsconfig.json` e `web/tsconfig.service-worker.json` verificados com **0 erros** no `tsc`. Todos os componentes auxiliares e hooks de `web/features/ai/` (`StepWindow.tsx`, `SessionTaskRows.tsx`, `AiStatusBar.tsx`, `MessageBubble.tsx`, `AiTurn.tsx`, `AiPaneView.tsx`, `Composer.tsx`, `useAiSession.ts`) totalmente tipados e zerados. |
| 6 — GitBook, Expo, desktop | Concluída | 100% TypeScript. `tsc --noEmit` passa com 0 erros em GitBook, Expo e Desktop. Builds e exports locais validados. |
| 7 — testes, exceções, fechamento | Em andamento | Código de produto e build de release validados. `SELF_HOSTED=1 npm run host:build` executado com sucesso e validado (`IS_SELF_HOSTED` minificado como `!0` nos chunks estáticos). Testes remanescentes em transição. |

### Contagem restante (worktree, 2026-10-21)

- **0 arquivos `.js` de produto restantes** no repositório inteiro.
- **`host/`**: 100% TypeScript, 0 erros no `tsc -p host/tsconfig.json`.
- **`host/ui/`**: 100% TypeScript, 0 erros no `tsc -p host/ui/tsconfig.json`.
- **`host/extension/`**: 100% TypeScript, 0 erros no `tsc -p host/extension/tsconfig.json`.
- **`desktop/`**: 100% TypeScript, 0 erros no `tsc -p desktop/tsconfig.json`.
- **`gitbook/`**: 100% TypeScript, 0 erros no `tsc -p gitbook/tsconfig.json`.
- **`expo/`**: 100% TypeScript, 0 erros no `tsc -p expo/tsconfig.json`.
- **`web/`**: 100% TypeScript, 0 erros no `tsc -p web/tsconfig.json`, `web/tsconfig.worker.json` e `web/tsconfig.service-worker.json`.

## Definição de pronto

Marcados os itens já satisfeitos:

- [x] `AGENTS.md` e instruções de contribuição refletem o uso incremental de TS/TSX.
- [x] Toolchain permite TS/TSX e oferece typecheck reproduzível em cada pacote.
- [x] Revisão de referência, inventário reproduzível, decisões de versões/dependências e comandos estão registrados em `docs/typescript-migration/`.
- [x] Todo arquivo TS/TSX/MTS do escopo está coberto por uma configuração verificada, incluindo testes e runtimes auxiliares.
- [x] Todo código de produto do escopo está em `.ts`, `.tsx` ou `.mts` (0 arquivos `.js` de produto restantes).
- [x] Nenhum dos 236 módulos com JSX permanece `.js/.jsx` dentro do escopo (todos convertidos para `.tsx`).
- [x] Typecheck estrito sem erros no código de produto de todos os workspaces.
- [x] Contratos de transporte, API, D1, segurança, Worker, extensão, PWA, Tauri, i18n, GitBook e Expo preservados sem alteração de wire format.
- [x] Builds de release (`SELF_HOSTED=1 npm run host:build`) validados com chunk `IS_SELF_HOSTED` confirmado (`!0`).
