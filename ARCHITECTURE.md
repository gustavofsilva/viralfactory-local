# Arquitetura

## Componentes

- `apps/web`: React 19, Vite, TypeScript, Tailwind 4 e CSS de componentes.
- `apps/api`: Fastify 5, worker da fila, RSS, ranking, diagnóstico e Ollama.
- `packages/shared`: contratos Zod, preferências e tipos da interface.
- `workers/media/worker.py`: Piper, Whisper/ASS e composição de cenas em Python.
- `D:/ViralFactoryLocal/data`: SQLite, caches, vídeos, áudios e logs de execução.
- `scripts`: ferramentas de instalação, banco, diagnóstico e inicialização.

Prisma 7.10 usa o adaptador better-sqlite3. Versões resolvidas ficam no
`package-lock.json`. O banco fica em `data/viralfactory.db` por padrão; SQLite
usa WAL. Migrações são versionadas e aplicadas com `prisma migrate deploy`.

## Persistência

`Source` registra feeds, categoria, habilitação e último erro. `Trend` registra
assuntos com fingerprint de título normalizado. `Observation` preserva URL,
nome da fonte, resumo, data de publicação e horário de coleta. Uma observação
por URL/assunto/hora evita duplicação na mesma coleta. Datas ausentes ficam
nulas; a data do acontecimento não é inferida da publicação.

`Video` é único por assunto, salva estado, roteiro, dossiê e erros. `Setting`
guarda preferências e `Cache` salva saídas validadas da IA por entrada/modelo.
`Job` e `JobLog` mantêm exclusividade, tentativas, timestamps e diagnóstico.

`Video.artifactJson` registra revisão, caminhos e duração do áudio, palavras com
timestamps, ASS, cenas, materiais/licenças e render final. O hash de revisão
inclui roteiro e opções de mídia. Arquivos ficam no D, em
`data/videos/<id>/<revision>/`. Edição invalida a revisão atual e preserva os
arquivos anteriores no disco.

## Fila

Estados de tarefa: QUEUED → RUNNING → COMPLETED; alternativamente
RETRY_PENDING, FAILED ou CANCELED. Um worker opera sequencialmente.

O worker seleciona um candidato e o adquire por atualização condicional de
estado e número de tentativas. Cada aquisição tem um UUID próprio e lease de
30 segundos, renovado a cada 5 segundos. Conclusão e gravação de roteiro exigem
o dono atual. Assim, um worker antigo não pode concluir uma tarefa retomada.

Leases expirados voltam para a fila, até o limite de tentativas. Falhas
temporárias usam backoff; dependências ausentes falham imediatamente. Repetir
reabre a mesma tarefa, preservando os logs. Cancelar revoga o lease. O
cancelamento de operações em andamento é observado no heartbeat ou próximo
checkpoint, com atraso de até cinco segundos; itens RSS já gravados ficam
preservados.

`start.ps1` guarda somente o PID do processo supervisor. `stop.ps1` verifica
PID e caminho, e encerra a árvore desse processo. Uma parada forçada é
recuperada pelo lease na próxima inicialização. Ctrl+C pelo terminal permite
o desligamento do worker, quando o sistema operacional entrega o sinal.

## Pesquisa e ranking

RSS/Atom reais são lidos com limites de tamanho, timeout, redirecionamento e
validação de endereços públicos. Entidades externas XML são recusadas. O
agrupamento atual por título normalizado não une manchetes diferentes sobre o
mesmo fato; agrupamento semântico será uma etapa posterior.

O ranking inicial (0–100) soma recência, nomes de fontes distintas, contexto
brasileiro da origem e existência de resumo datado. Crescimento é diferença
entre quantidades de links em duas horas observadas; não mede engajamento
social. Fontes replicadas podem compartilhar um nome e nomes diferentes não
provam independência editorial. Esses limites ficam explícitos na interface.

O cron verifica a cada minuto se a pesquisa periódica está habilitada. A chave
de deduplicação inclui intervalo e janela temporal, persistida em SQLite.
O módulo agent.ts seleciona fontes substanciais e encadeia SCRIPT → PRODUCE
para dois horários diários. Não há execução com o computador desligado.

## Roteiros

O adaptador verifica serviço e modelo Ollama, reúne textos datados e gera JSON
com schema. Manchetes de descoberta Google News não são usadas como corpo de
evidência. Textos originais ou importados precisam ser substanciais; uma reserva
total de 4.500 caracteres limita o contexto entre até três fontes.

O servidor seleciona trechos por correspondência lexical e copia URL e texto
literal da fonte, impedindo citações fabricadas. Essa correspondência não prova
entailment; uma chamada separada confere cada afirmação e contexto. O adaptador
antigo por índices foi preservado para compatibilidade e testes. A narração é
rejeitada ao copiar mais de 20 palavras consecutivas da fonte. Uma segunda
chamada de IA avalia afirmações do roteiro contra as fontes. Essa revisão pode
ter erros e não representa confirmação independente. Candidatos rejeitados
ficam registrados em `data/logs/rejected-drafts` para diagnóstico.
Timeout, três tentativas de validação e cache são implementados. Qwen3 usa
modo de raciocínio; Qwen3.5 usa think=false. O contexto é de 8.192 tokens; o texto
de fontes e o tamanho dos campos permanecem limitados. Uma execução
por vez limita concorrência de geração de texto.

RESEARCHED significa dossiê montado, não confirmação independente concluída.
SCRIPTED significa rascunho salvo. Todo roteiro exige revisão humana.
Assuntos sensíveis são marcados pelo modelo e por uma heurística adicional;
essa heurística não é garantia de detecção completa. A narração permanece
dependente de avaliação humana para fatos e coerência com as fontes.

O job PRODUCE executa Piper → cenas/Commons → Whisper/ASS → FFmpeg → ffprobe.
Cada checkpoint atualiza AUDIO_READY, MEDIA_READY, SUBTITLES_READY, RENDERED e
REVIEW_PENDING. APPROVED exige uma ação explícita na interface. Assuntos
sensíveis exigem confirmação de revisão do roteiro antes de PRODUCE.

Subprocessos recebem argumentos explícitos e JSON de entrada/saída, sem shell.
Timeout/cancelamento encerram somente a árvore de processos criada para a
tarefa. O áudio é sintetizado em arquivo temporário; MP4 é verificado antes da
troca para o nome final. Timestamps do Whisper vêm do áudio real já ajustado
ao ritmo desejado. Cortes das cenas usam os timestamps das palavras.

Imagens Commons aceitas têm autor e licença CC0, domínio público ou CC BY;
NC/ND, ShareAlike e restrições desconhecidas não entram nesta primeira versão.
Arquivos têm cache e metadados de licença. Grafismos próprios são o fallback.
Imagens externas recebem a indicação de imagem ilustrativa.
Uma heurística de correspondência de termos do título descarta resultados
sem relação aparente com a busca; isso não substitui a revisão visual. Autoria
desconhecida é recusada. Roteiros têm origem ollama ou edited; edição pela API
sempre salva edited e apaga qualquer confirmação de revisão anterior.

FFmpeg compõe 1080×1920, 30 FPS, H.264/AAC, zoom discreto, cortes, legendas com
destaque e áudio normalizado. NVENC é usado somente após teste real; nesta
máquina há incompatibilidade com o driver, então libx264 é o encoder ativo.
`/api/videos/:id/file/:kind` oferece streaming com Range e download de vídeo,
áudio, capa, legendas e metadados, restringindo caminhos à própria produção.

Uploads oficiais ainda não estão implementados. PUBLISHED pode ser registrado
pelo protótipo de navegador ou por confirmação manual explícita.

## Agente e navegador local

AgentSlot persiste horário, vídeo, até três seleções, erros, URL, instante de
início do envio e evidências. Chaves por data/horário impedem agenda duplicada.
O cron verifica a rotina a cada minuto. A produção trabalha com antecedência;
horários atrasados mais de duas horas são encerrados, evitando publicar em lote.

TIKTOK_PUBLISH usa a mesma fila com apenas uma tentativa. A intenção de envio
é gravada sob lease antes do clique externo; se houver interrupção posterior,
o resultado fica UNKNOWN e não é repetido. A quota considera até dois envios
iniciados por dia de São Paulo, inclusive os de resultado incerto.

TikTokBrowser utiliza Playwright e Chrome já instalado, com perfil próprio no
D. Login é pessoal; cookies e senhas não são extraídos pelo aplicativo. Somente
elementos da interface são usados. A identidade da conta deve aparecer na tela
de upload. O resultado exige uma URL nova, da conta configurada, com vídeo e
legenda compatíveis na página. Esse fluxo ainda precisa de teste autenticado.

Roteiros do Ollama de risco normal podem seguir a política automática escolhida;
esse caminho não grava aprovação humana. Conteúdo sensível, judicial e político
é retido para revisão. Roteiros editados exigem aprovação do vídeo. Normalização
e regex complementam a classificação do modelo; não garantem detecção completa.

install-agent-autostart.ps1 cria um atalho no Startup do usuário, sem elevar
privilégios ou alterar políticas do Windows. start.ps1 supervisiona os serviços.

## API e execução

O modo de navegador pode ser persistent (perfil separado) ou extension (uma aba
do Chrome habitual autorizada pelo usuário). A extensão Manifest V3 usa activeTab,
scripting, storage.session e alarms; só possui permissão de rede para 127.0.0.1.
Não lê cookies ou credenciais nem efetua login. O usuário carrega o pacote no D
e seleciona a aba. Fechar/reabrir Chrome exige selecionar a aba novamente.

A ponte aceita somente os comandos definidos: inspeção, navegação restrita,
upload de arquivo vinculado à tarefa, legenda, prontidão, clique e confirmação.
Comandos têm conexão, identificador e prazo. São entregues uma vez; recibos podem
ser repetidos. O servidor confere lease, conta, configuração e versão do vídeo
antes da entrega e novamente antes da execução. A intenção de publicação é
gravada antes da entrega de SUBMIT. Resultados interrompidos continuam UNKNOWN.

Rotas /api/agent/extension/bridge exigem chave local de 256 bits, inclusive GET
de arquivo. Origin externo é recusado; só essas rotas permitem Origin de extensão
autenticada. A chave fica no runtime e config.js do pacote no D, nunca no fonte.
Os registros da conexão e comandos são transitórios; intentos/resultados de
publicação continuam persistidos no SQLite e nos arquivos de evidência.

API e Vite escutam somente em 127.0.0.1. O backend valida Host e Origin em
operações de escrita, exige JSON e limita o corpo. Não há publicação na rede
local nem na internet. O dashboard compilado é servido pelo próprio Fastify,
dispensando um servidor Vite para o uso diário.

Rotas principais: `/api/health`, `/api/overview`, `/api/trends`,
`/api/trends/import`, `/api/discover`, `/api/sources`, `/api/jobs`,
`/api/videos`, `/api/settings`, `/api/doctor` e `/api/connectors`.

Diagnóstico utiliza subprocessos com executável e argumentos explícitos,
timeout e janela oculta. NVENC só recebe status disponível após codificar um
frame real. Vozes encontradas sem validação de síntese/licença recebem aviso.

## Próximas decisões

O usuário autorizou dependências e definiu disco D. Ollama, bibliotecas GPU,
Python virtual, FFmpeg, modelos, cache e arquivos produzidos ficam em
`D:/ViralFactoryLocal`. O supervisor inicia o Ollama portátil, usa seu diretório
de modelos no D e desabilita uso da nuvem. Python roda em CPU para Piper/Whisper;
Ollama usa a RTX 3050. A GPU não é requisito para renderizar.

Próximos passos: estabilizar geração/auditoria de roteiros, biblioteca de uploads,
cache independente por etapa, música/ducking, seleção semiautomática diária e
conectores adicionais. Manter publicação separada do pipeline local.
