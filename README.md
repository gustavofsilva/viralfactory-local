# ViralFactory Local

O painel **Clipes** permite cadastrar contas TikTok separadas, importar MP4/MOV locais, sugerir cortes de 60 a 90 segundos, renderizar um clipe vertical e enviá-lo pela extensão da conta escolhida. Veja o [guia de operação](GUIA_OPERACAO_E_INSTALACAO.md) e o [escopo da expansão](PLANO_MULTICONTAS_E_CLIPES.md).

Veja [GUIA_OPERACAO_E_INSTALACAO.md](GUIA_OPERACAO_E_INSTALACAO.md) para custos, fluxo de pesquisa até postagem, agenda e instalação em outro computador.

Estúdio local em português para pesquisar assuntos e preparar vídeos curtos.
Execução em Windows, sem Docker e sem APIs pagas de IA.

## Estado desta entrega

Implementado: dashboard, API Fastify, Prisma/SQLite, fila persistente, pesquisa
real em RSS/Google News, importação manual, ranking explicável, gerenciamento
de fontes, diagnóstico, Ollama, Piper, legendas Whisper/ASS, busca de imagens
licenciadas no Wikimedia Commons e cenas próprias, composição FFmpeg, prévia
e download de MP4. Consulte PROGRESS para a validação real mais recente.

O agente local agenda pesquisa, seleção, roteiros e produção. O envio pelo
site do TikTok está implementado como protótipo e depende de validação com
sua conta autenticada. APIs oficiais, conectores de tendências adicionais,
biblioteca de uploads e música/ducking continuam pendentes.

As ferramentas, modelos e dados estão em **D:/ViralFactoryLocal**, conforme
autorização explícita do usuário. O código permanece nesta pasta. A cópia antiga
do banco no projeto é um backup; o aplicativo usa o SQLite no D.
Dependências Node ficam em `D:/ViralFactoryLocal/tools/node-dependencies/`,
acessadas pelo projeto por uma junction. O cache npm também está no D. Uma
cópia anterior foi preservada em `.node_modules-before-D` no C após o bloqueio
automático da sua exclusão.

## Abrir o aplicativo

Na pasta do projeto, use PowerShell:

```powershell
.\start.ps1
```

Abra **http://127.0.0.1:4310**. O script prepara o banco, compila o dashboard e
inicia o servidor em segundo plano, com logs em `data/runtime/`.

```powershell
.\stop.ps1
.\doctor.ps1
```

O Windows deve permitir a execução de scripts conforme a política definida
pelo usuário. Os scripts não alteram essa política. Como alternativa:

```powershell
npm run db:setup
npm run build
npm start
```

Nesse modo, encerre com Ctrl+C. Não combine esse comando com uma instância
iniciada por `start.ps1` nas mesmas portas.

## Instalação em outro computador

Requisito: Node.js 22.12 ou superior (testado aqui com 24.20.0).

```powershell
.\install.ps1
.\start.ps1
```

`install.ps1` pede autorização para baixar dependências locais e preparar o
banco. Não instala Node, Python, Ollama, FFmpeg nem modelos globalmente.
O parâmetro `-Yes` indica autorização explícita para a instalação local.
As dependências npm são instaladas no D por `configure-node-storage.ps1`.

Para preparar IA e mídia após autorizar os downloads:

```powershell
powershell -NoProfile -File scripts/configure-storage.ps1
powershell -NoProfile -File scripts/install-media.ps1
python scripts/install-model.py
python scripts/install-whisper.py
```

Esses scripts usam o disco D. Downloads incluem o pacote oficial portátil do
Ollama, modelo quantizado, FFmpeg e voz; checksums e model card são preservados.
`scripts/download.py` permite downloads por intervalos com retomada caso os
downloads grandes fiquem lentos. O ambiente Python e seus caches ficam no D.

## Primeira pesquisa

1. Abra o dashboard e clique em **Pesquisar tendências**.
2. Acompanhe a pesquisa em **Fila de produção**.
3. Abra **Tendências** e confira o assunto, as datas e os links de origem.
4. Em **Configurações**, teste, habilite ou desabilite fontes.
5. Use **Importar assunto** para incluir um link, um texto verificável e a data.

Feeds retornam títulos e resumos; isso não equivale a ler a matéria completa.
Google News é usado para descoberta. Para gerar roteiros, o sistema exige texto
substancial da fonte original ou importado. Manchetes isoladas são recusadas.
O agrupamento atual usa título normalizado e é conservador. Agrupamento
semântico de fatos e confirmação independente ainda serão implementados.

## Preparar a geração de roteiro

O Ollama portátil já foi autorizado e instalado no D nesta máquina. Ele é
iniciado junto com o aplicativo, se não houver um serviço respondendo na porta
local. Modelos ficam em `D:/ViralFactoryLocal/data/models/ollama`.

Em outro computador, prepare o [Ollama oficial](https://ollama.com/download/windows)
após autorizar a instalação. Para baixar um modelo via CLI, use o executável
local e preserve `OLLAMA_MODELS` apontando para o D:

```powershell
$env:OLLAMA_MODELS = 'D:/ViralFactoryLocal/data/models/ollama'
& 'D:/ViralFactoryLocal/tools/ollama/ollama.exe' pull qwen3:4b
```

Confira **Configurações → Diagnóstico do ambiente**. O modelo é selecionável
na interface. O catálogo oficial também tem variantes Qwen menores; a escolha
deverá ser testada com o hardware e a memória disponíveis.
Nesta máquina estão instalados `qwen3:4b` e `qwen3.5:4b`; o segundo está
selecionado para redação; `qwen3:4b` confere os fatos com raciocínio habilitado,
por `OLLAMA_AUDIT_MODEL`. A redação da narração é separada dos metadados. As cenas preservam
todas as palavras na ordem original; trechos de evidência são escolhidos pelo
servidor e conferidos individualmente por IA. Há riscos de falsos positivos e
negativos. As primeiras versões automáticas chegaram a renderizar, mas foram
rejeitadas por uma revisão adicional. Consulte PROGRESS para o estado atual.

Clique em **Criar roteiro** em um assunto. Caso o Ollama esteja ausente, a
tarefa falha com uma mensagem explícita; após preparar a dependência, use
**Repetir** na fila. Produções sobre o mesmo título normalizado reutilizam o
registro existente. O limite diário conta produções ativas/prontas iniciadas no
dia, no fuso de São Paulo. Falhas e cancelamentos liberam espaço no limite.

O modelo recebe somente evidências datadas. As citações são selecionadas por
índices e copiadas diretamente da fonte; o modelo não escreve o trecho citado.
O JSON é validado e uma segunda chamada avalia a consistência com as fontes,
rejeitando extrapolações. Todo resultado permanece um rascunho. No agente,
a opção de publicar roteiros do Ollama não sensíveis sem revisão manual é
configurável; essa opção não simula aprovação humana. Conteúdo sensível,
judicial, político ou editado exige revisão. A avaliação por IA não equivale
a confirmação independente de fatos.

Editar a narração não atualiza automaticamente os trechos de evidência. Revise
as afirmações e suas fontes antes de qualquer produção futura.

## Produzir e baixar um vídeo

1. Abra uma produção com roteiro no **Estúdio** e confira as fontes.
2. Assuntos sensíveis exigem **Confirmar revisão do roteiro** antes da produção.
3. Clique em **Gerar vídeo**. A fila executa Piper, cenas, Whisper e FFmpeg.
4. O áudio é ajustado à duração desejada quando o ajuste preserva um ritmo
   razoável. Timestamps são obtidos do áudio final; não são divididos igualmente.
5. Assista à prévia, ouça a narração e use **Baixar MP4**.
6. Revise o vídeo antes de usar **Aprovar vídeo revisado**. A produção fica em
   REVIEW_PENDING até sua aprovação.

São três templates: Notícias, Viral e Curiosidades. Configurações oferecem
velocidade de voz, tamanho/cor/posição das legendas, mídia Commons ou grafismos
originais e seleção de encoder. Arquivos usam H.264/AAC, 1080×1920, 30 FPS.

O encoder NVENC é testado realmente. Nesta máquina, os builds testados exigem
NVENC API 13.1 e o driver oferece 13.0; portanto o sistema usa libx264. A IA
local utiliza a RTX 3050 via CUDA. Nenhum driver foi alterado.

Imagens do Commons precisam de licença aceita e autor identificado. Licenças
NC/ND, restrições desconhecidas e ShareAlike não são usadas nesta primeira
versão. Quando não há imagem adequada, são criados grafismos originais.
Fontes e créditos ficam em `metadata.json` e no botão **Copiar metadados**.
Revise direitos de imagem e contexto antes de publicar.

Cada etapa salva seu resultado. Repetir uma tarefa recupera arquivos da revisão
atual. Alterar roteiro ou configurações de mídia gera uma nova revisão, mantendo
os arquivos antigos no disco, mas exibindo somente a produção atual na interface.

## Agente local — dois vídeos por dia

Abra **Agente local** no painel. A rotina está configurada inicialmente para
12h e 19h, no fuso de São Paulo. Os horários são editáveis. O agente opera no
próprio computador e não depende desta conversa permanecer aberta.

- Pesquisa automática e produção podem funcionar antes de conectar o TikTok.
- A produção começa quatro horas antes do horário; **Preparar próximos vídeos**
  antecipa a preparação. Até três assuntos podem ser tentados por horário.
- Fonte insuficiente, tema sensível ou falha de geração pode deixar um horário
  sem vídeo. O alvo de duração é aproximado; o áudio final precisa ter 15–90 s.
- Após criar sua conta, informe o @ e salve. Clique em **Abrir TikTok para login**,
  entre pessoalmente e use **Verificar conta**, se usar o navegador separado.
  Para usar seu Chrome habitual, escolha a conexão por extensão descrita abaixo.
- Habilite **Publicar nos horários escolhidos** quando estiver pronto para o
  teste real. Sem a conta identificada na página, não ocorre publicação.
- Com um vídeo pronto e a conta verificada, **Testar envio agora** antecipa o
  envio daquele horário. Esse teste publica de verdade e consome o horário.
- O envio pelo site é experimental. Mudanças na página, login ou verificações
  podem exigir intervenção. O sistema não disfarça automação nem contorna
  verificações. A privacidade configurada na tela do TikTok é preservada.
- O agente registra a intenção antes de clicar em publicar. Se a confirmação
  ficar incerta, não repete o envio; confira a conta e registre a URL no painel.
  São permitidos no máximo dois envios por dia, incluindo resultados incertos.
- URLs só recebem estado publicado após confirmação no navegador ou uma
  confirmação manual explícita. Créditos de imagens, fontes e identificação da
  narração gerada por IA entram na legenda. Novos grafismos também identificam
  a narração por IA no próprio vídeo.

Se aparecer **Número máximo de tentativas atingido. Tente mais tarde.**, pare
as tentativas e use **Pausar conexão**. A pausa é salva no banco, bloqueia abrir,
verificar e publicar pelo agente, mas permite continuar pesquisando e criando.
**Retomar conexão** libera os controles e mantém a publicação desativada; não
tenta entrar automaticamente. A mensagem sozinha não identifica a causa do
bloqueio e não fornece prazo exato de liberação. Se persistir, use o suporte do
TikTok. Entrar no Chrome comum não conecta automaticamente o perfil do agente.

A integração oficial também tem limites: Direct Post exige aplicativo aprovado
e autorização da conta; clientes sem auditoria publicam somente em modo privado.
As diretrizes excluem ferramentas limitadas ao uso interno para contas próprias.
Por isso não tratar a API como solução garantida para este agente pessoal.
Fontes: [Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
e [diretrizes](https://developers.tiktok.com/docs/en/content-sharing-guidelines).

O perfil do navegador fica em D:/ViralFactoryLocal/data/browser/tiktok.
Esse diretório é usado somente pelo navegador separado; no modo extensão, a
sessão fica no Chrome habitual e não é copiada para o aplicativo.
O aplicativo não pede nem registra sua senha. O computador precisa estar ligado
e com sua sessão do Windows disponível. Login expirado interrompe o envio.

Inicialização no login do Windows:

```powershell
.\install-agent-autostart.ps1
# Para desfazer:
.\install-agent-autostart.ps1 -Remove
```

Esse atalho já foi instalado nesta máquina. Ele usa start.ps1 e janela oculta.
Desativar a publicação no painel impede novos envios; stop.ps1 encerra o agente.

### Conectar uma aba do Chrome habitual

A extensão local está implementada como protótipo. Prepare-a em **Agente local
→ Preparar extensão**. Nesta máquina a pasta preparada é
`D:/ViralFactoryLocal/tools/chrome-extension`.

1. No Chrome em que você entrou no TikTok, abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor**, clique em **Carregar sem compactação** e
   selecione a pasta acima. Isso é feito pessoalmente no Chrome.
3. Abra `https://www.tiktok.com/tiktokstudio/upload` nesse mesmo Chrome.
4. Abra a extensão **ViralFactory — conexão local** e clique em **Conectar esta aba**.
5. Em Agente local, selecione **Extensão no meu Chrome habitual** e salve.
   Deixe o @ visível no cabeçalho/menu de perfil e use **Verificar conta**.
6. Só depois da conta identificada e de um vídeo elegível pronto, habilite a
   publicação para validar um envio real. O login anterior no perfil separado
   continua independente. Trocar de modo ou conta desativa a publicação.

Permissões: acesso temporário à aba escolhida, execução do conector nessa aba,
armazenamento próprio da conexão, alarmes e comunicação com 127.0.0.1.
Não são solicitadas permissões de cookies, histórico ou depuração. A extensão
não copia a sessão, não acessa outras páginas e não realiza login. O aplicativo
valida conta, legenda, tarefa e permissões antes de entregar comandos.

A aba escolhida precisa permanecer aberta. Após fechar/reabrir o Chrome,
conecte a aba novamente; o identificador fica apenas na memória da extensão
para evitar associar outra aba a um identificador reutilizado. O aplicativo
pode reiniciar mantendo o perfil do Chrome; comandos já entregues não são
repetidos. Recibos podem ser reenviados após falha de rede, sem repetir cliques.

Arquivo de configuração preparado no D contém uma chave de comunicação local,
que não é uma credencial do TikTok. Não compartilhe a pasta preparada. O código
fonte da extensão está em `extensions/chrome`, sem essa chave. Para atualizar
os arquivos após alterações, prepare novamente e recarregue a extensão no Chrome.

A extensão pode parar se a página mudar, exigir verificações ou não expuser a
identidade da conta. Os testes locais usam páginas artificiais e não confirmam
que o TikTok aceite o upload ou a postagem automática numa conta real.

## Variáveis de ambiente

Copie `.env.example` para `.env` se necessário. Opções:

- `API_PORT`: API e dashboard compilado (4310).
- `WEB_PORT`: Vite no modo desenvolvimento (5173).
- `DATA_DIR`: diretório local de dados (D:/ViralFactoryLocal/data nesta máquina).
- `TOOLS_DIR`: ferramentas portáteis (D:/ViralFactoryLocal/tools).
- `OLLAMA_URL`: serviço local (127.0.0.1:11434).
- `OLLAMA_AUDIT_MODEL`: modelo de conferência factual (qwen3:4b nesta máquina).
- `OLLAMA_TIMEOUT_MS`: timeout da geração.
- `FFMPEG_PATH`, `FFPROBE_PATH` e `PYTHON_PATH`: executáveis locais.
- `PIPER_MODEL`, `WHISPER_MODEL` e `OLLAMA_MODELS`: modelos no D.

Preferências do dashboard são salvas no SQLite. O agente habilitado pesquisa
a cada hora e prepara dois horários por dia. A opção legada de pesquisa
periódica e o limite de produções do estúdio são configurações separadas.
A publicação pelo navegador está pausada após o primeiro teste real em
@brasilgerais: o vídeo saiu, mas o TikTok usou o nome do arquivo como legenda,
sem o texto e a fonte preparados. `publicationEnabled` e `autoPublishNormal`
estão desligados enquanto a legenda e a auditoria factual são corrigidas.
A extensão 0.1.1 exige recarga no Chrome
antes de um novo teste. Confira a legenda publicada e o histórico em PROGRESS.md.

O ranking soma recência (30), cobertura por nomes de fontes (15), contexto
brasileiro da fonte (20), disponibilidade de resumo datado (20) e sinais de
acontecimentos próximos ou em andamento (15). Esses fatores
são indícios, não atestados de confiabilidade. Crescimento de cobertura é
exibido somente após duas coletas em horas diferentes e não participa da
pontuação inicial. Não são inventados likes, views ou volumes de pesquisa.

## Desenvolvimento e validação

```powershell
npm run dev
npm run build
npm test
npm run test:browser
npm run test:extension
npm run doctor
```

No modo desenvolvimento: **http://127.0.0.1:5173**, API em 4310.
Os testes usam bancos isolados para verificar concorrência, leasing, retries,
cancelamento, reinício, ingestão RSS, ranking e validação HTTP. Nenhum item
fictício de teste é inserido no banco de produção.

`test:browser` requer o aplicativo iniciado em 4310 e usa o Chrome instalado,
sem baixar outro navegador. Configure `BROWSER_PATH` caso o executável esteja
em outro local. Capturas de desktop/mobile ficam em `data/qa/`.

Consulte [ARCHITECTURE.md](ARCHITECTURE.md) para os contratos e
[PROGRESS.md](PROGRESS.md) para os resultados e instruções de retomada.

## Juntar roteiros curtos e usar fotos das fontes

Em **Biblioteca → Juntar roteiros curtos**, selecione 2 ou 3 roteiros já revisados
com até 30 segundos cada. O sistema cria um vídeo com um bloco por assunto,
na ordem selecionada, mantendo a narração integral, fontes e créditos. A montagem
vai para o Estúdio e exige revisão do vídeo antes da publicação. Um assunto
sozinho continua sendo produzido pelo fluxo normal.

Ao gerar cenas, o aplicativo procura fotos nas matérias citadas. Atualmente usa
fotos próprias da Agência Brasil que tenham crédito explícito de autoria e
estejam hospedadas pela EBC; imagens de parceiros são ignoradas. Se a matéria
não oferecer foto elegível, a busca do Wikimedia Commons e o grafismo original
continuam disponíveis. O crédito de cada foto aparece no vídeo e nos metadados.
