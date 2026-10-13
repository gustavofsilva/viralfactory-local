# ViralFactory Local — funcionamento e instalação

Este guia descreve o aplicativo que roda neste computador em 13/10/2026. O painel local fica em `http://127.0.0.1:4310`. Código: pasta `videomaker`; dados, modelos, ferramentas, vídeos e banco: `D:\ViralFactoryLocal`. O aplicativo não precisa que esta conversa com Codex fique aberta.

## Custos e autonomia

- A pesquisa usa feeds RSS e páginas públicas. O roteiro e a auditoria usam Ollama com modelo local. A narração usa Piper; legendas usam Whisper local; a montagem usa FFmpeg. O código não chama a API da OpenAI e não usa créditos da OpenAI para cada vídeo. Esses modelos processam *tokens* internamente, mas não geram cobrança por token de API. Há consumo de energia, disco e internet para buscar notícias, imagens e o TikTok.
- Conversar com Codex para instalar, alterar ou diagnosticar o projeto usa a franquia ou os créditos da sua conta ChatGPT/Codex, conforme seu plano. Consulte a [documentação oficial de preços e uso](https://learn.chatgpt.com/docs/pricing). A rotina local continua mesmo sem Codex aberto.
- Pesquisa, geração, narração, legendas, renderização e fila podem rodar sozinhas com o PC ligado. **Postagem automática ainda não é garantida**: a extensão precisa estar conectada à aba correta do TikTok Studio, a conta deve ser reconhecida, o site pode pedir confirmação e temas eleitorais exigem revisão humana. Um envio incerto não é repetido automaticamente para evitar duplicação.

## Do início à postagem

1. A cada hora, o agente lê RSS de Google News, Agência Brasil e notícias do TSE. O ranking prioriza atualidade, contexto brasileiro, fontes e acontecimentos próximos. Uma manchete sem matéria e texto suficientes não vira roteiro.
2. Para cada horário, o agente escolhe uma matéria recente ainda não usada. Com foco eleitoral, tenta primeiro uma notícia eleitoral do TSE ou da Agência Brasil. Na campanha temporária por hora, se não houver pauta eleitoral elegível, pode escolher notícia geral não sensível.
3. O Ollama local escreve roteiro e uma segunda etapa confere afirmações com trechos das fontes. Tentativas com falhas podem ser rejeitadas e registradas na **Fila de produção**. A auditoria automática pode errar: confira as fontes antes de aprovar assuntos sensíveis.
4. O Piper cria a narração em português, atualmente a 1,15×. O aplicativo procura foto própria da Agência Brasil com crédito explícito e hospedagem EBC; se não houver, tenta mídia com licença aceita no Wikimedia Commons e depois grafismo original. O Whisper gera tempos das palavras e o FFmpeg monta vídeo vertical H.264/AAC, com intro de 1 s, `@brasilgerais` e “CURTE E SIGA PARA MAIS”. Arquivos ficam em `D:\ViralFactoryLocal\data\videos`.
5. O vídeo aparece no **Estúdio** para prévia e download. Roteiros eleitorais ou outros temas sensíveis esperam **Confirmar revisão do roteiro**; roteiros editados e vídeos não elegíveis esperam aprovação. Roteiros normais do Ollama podem ser publicados sem essa aprovação apenas quando a opção correspondente estiver ativa. Na campanha por hora, essa exceção termina junto com a campanha.
6. Na hora prevista, o agente entrega um único comando à extensão instalada no Chrome habitual. Ela usa somente a aba conectada do TikTok Studio, confere `@brasilgerais`, carrega o MP4 e tenta publicar. O modo atual de descrição é **somente fonte** e admite que o TikTok não confirme a persistência da legenda. Confira a descrição pública quando o post aparecer.
7. Se o TikTok pedir login, mostrar um bloqueio, trocar a interface ou deixar o resultado incerto, veja **Agente local → Agenda e resultados**. Horários `WAITING_REVIEW` precisam da sua revisão; `WAITING_LOGIN` exigem reconexão; `UNKNOWN` exigem conferir o perfil antes de informar a URL. Não reenvie manualmente um horário `UNKNOWN` sem essa conferência.

## Campanha temporária de 13 a 14/10/2026

A agenda solicitada vai de **13/10 às 01h até 14/10 às 23h**, um horário por hora, no fuso de São Paulo: 23 horários no dia 13 e 24 no dia 14, **47 horários planejados**. O fim é exclusivo em 15/10 às 00h. Depois, o agente volta aos horários habituais de 12h e 19h. A permissão especial para publicar notícias gerais não sensíveis automaticamente vale somente durante a campanha. Temas eleitorais continuam exigindo revisão.

Os horários são oportunidades de publicação, não promessa de 47 posts: faltas de notícias verificáveis, falhas de geração, revisão pendente, PC desligado, conexão da extensão ou resposta do TikTok podem deixar horários sem vídeo. O sistema não acumula uma sequência de posts atrasados. O ritmo de uma postagem por hora também pode receber verificações adicionais do TikTok; monitore a conta.

Para encerrar antes do prazo, abra **Agente local → Encerrar agenda por hora**. Para parar todo envio, desative **Publicar nos horários escolhidos**; pesquisa e produção podem continuar. Para interromper tudo, desative **Pesquisar e produzir automaticamente**.

## Instalar em outro computador Windows

Requisitos: disco `D:` com espaço para modelos e vídeos, Node.js 22.12 ou superior, Python disponível no terminal para criar o ambiente local, Google Chrome, internet para o preparo e acesso às fontes. O projeto não instala Node ou Python globalmente. Copie a pasta do projeto para o novo computador sem `node_modules`; os scripts instalam as dependências no disco D. Abra PowerShell **na pasta do projeto** e execute, em ordem:

```powershell
.\install.ps1 -Yes
.\scripts\configure-storage.ps1
.\scripts\install-media.ps1
python .\scripts\install-model.py
python .\scripts\install-whisper.py
.\start.ps1
.\doctor.ps1
```

`install.ps1` prepara dependências Node e SQLite; `configure-storage.ps1` aponta `.env` para `D:\ViralFactoryLocal`; `install-media.ps1` prepara Ollama, FFmpeg, voz e ambiente Python no D. Os dois scripts Python baixam e verificam os modelos locais. O primeiro preparo pode baixar vários gigabytes. `doctor.ps1` deve mostrar Ollama, modelo, Piper, Whisper, FFmpeg e banco disponíveis. Abra `http://127.0.0.1:4310`. Para fechar, use `.\stop.ps1`.

Se quiser iniciar ao entrar no Windows, execute `.\install-agent-autostart.ps1`. O PC precisa permanecer ligado e com o usuário conectado. Para desfazer, execute `.\install-agent-autostart.ps1 -Remove`.

## Conectar o TikTok no novo computador

1. Faça login **pessoalmente** em `@brasilgerais` no Chrome habitual. Não envie senha ao aplicativo.
2. No painel, em **Agente local**, clique **Preparar extensão**. Em `chrome://extensions`, ative o modo do desenvolvedor, escolha **Carregar sem compactação** e selecione a pasta indicada pelo painel em `D:\ViralFactoryLocal\tools\chrome-extension`.
3. Abra `https://www.tiktok.com/tiktokstudio/upload` no mesmo Chrome, mostre o @ no cabeçalho ou no menu do avatar e use **Conectar esta aba** na extensão. Mantenha a aba e o Chrome abertos. Clique **Verificar conta** no painel; o estado deve ser `CONNECTED` e a conta `brasilgerais`.
4. Confira fontes e um MP4 no Estúdio, ative o agente e a publicação no painel. Faça um teste acompanhado e confira o post público, inclusive a descrição. O login e a conexão da aba devem ser refeitos no novo computador; não copie cookies nem a chave da extensão do computador antigo.

Para migrar histórico e vídeos, pare o aplicativo nos dois computadores e copie `D:\ViralFactoryLocal\data` para o mesmo caminho no novo PC antes de iniciar. Faça um backup da pasta antes da cópia. Isso inclui SQLite, vídeos e registros de publicação, mas **não transfere a sessão do TikTok**. Se preferir começar do zero, deixe o novo `data` ser criado pelo instalador.

## Onde acompanhar problemas

- **Agente local → Agenda e resultados**: cada horário, estado e link do post.
- **Fila de produção**: tentativas, erros de fonte, roteiro e renderização.
- **Estúdio**: roteiro, evidências, prévia, créditos e aprovação.
- `D:\ViralFactoryLocal\data\runtime\server.stderr.log` e `server.stdout.log`: logs do serviço.
- `D:\ViralFactoryLocal\data\publications`: evidências de envio. Não apague um registro `UNKNOWN` antes de conferir o TikTok.

O projeto tem mais detalhes em [README.md](README.md) e [ARCHITECTURE.md](ARCHITECTURE.md).
# Contas adicionais e clipes de vídeos longos

Abra **Clipes** no painel local. A conta principal `@brasilgerais` aparece automaticamente depois da migração do banco. Para outra conta, cadastre o `@`, clique em **Preparar extensão** e carregue a pasta indicada em **um perfil separado do Chrome** (`chrome://extensions` → Modo do desenvolvedor → Carregar sem compactação). Nesse perfil, faça o login você mesmo, abra `https://www.tiktok.com/tiktokstudio/upload` e clique em **Conectar esta aba** na extensão. O painel só libera o envio quando o `@` mostrado pelo TikTok corresponde ao cadastrado. Não copie cookies ou senhas entre perfis.

Para criar um clipe, escolha a conta, um MP4/MOV local com áudio de 1 a 30 minutos (até 1 GB), título e legenda. Confirme que pode editar e publicar o material. O navegador copia o arquivo para `D:\ViralFactoryLocal\data\clips` em partes de 4 MB; se a cópia parar, selecione o mesmo arquivo e o registro **UPLOADING** para retomar. Whisper transcreve a fala localmente e Ollama sugere trechos que somam de 60 a 90 segundos. Você pode alterar os tempos, remover/adicionar trechos, salvar e clicar em **Gerar clipe**. Confira o MP4 vertical final no painel e ajuste a legenda antes de enviar.

**Publicar em @conta** envia uma única vez pela aba conectada. O TikTok já mostrou comportamento inconsistente com a persistência da legenda nesta instalação; a caixa de confirmação informa esse risco. Quando a URL pública não puder ser confirmada, o clipe fica **UNKNOWN** e não é reenviado automaticamente. Confira a conta no TikTok e registre a URL em uma correção manual antes de qualquer outra ação. Contas adicionais não alteram a agenda automática da conta principal: nesta versão, clipes são publicados sob demanda.

Os arquivos de origem, transcrição, cortes, intermediários, MP4 final e evidências ficam no diretório de cada clipe no D. O token local da extensão fica fora do Git. Para validar em outra máquina com o ambiente de mídia já instalado, execute `npm run build`, `npm test` e `npm run test:clips`; o último cria um vídeo sintético em uma pasta temporária no D, testa renderização e importação pela API, e remove a pasta ao concluir.

## Temporadas em lote

Na aba **Clipes → Temporadas em lote**, escolha a conta e o intervalo mínimo entre posts, confirme sua autorização para os arquivos e crie o lote. O sistema indexa MKV/MP4/MOV de `D:\ViralFactoryLocal\videos` sem copiar os originais. Depois de **Ativar lote**, processa um episódio por vez: verifica duração e codecs, transcreve a fala em português, usa o modelo local para sugerir momentos narrativos, renderiza um clipe vertical de 60–90 s e publica pela extensão da conta escolhida. A seleção considera principalmente a fala; cenas importantes sem diálogo podem não ser identificadas. Os arquivos de origem permanecem na pasta original.

A próxima publicação ocorre no mínimo após o intervalo configurado, contando do envio anterior. O lote espera a extensão confirmar o `@` correto; falhas, envios incertos ou uma mudança no arquivo de origem interrompem o avanço até serem conferidos. **Pausar lote** impede novos episódios de entrarem na fila. A campanha de notícias usa a mesma fila local e tem prioridade quando já há tarefa ativa. O primeiro episódio real deve ser acompanhado no painel e no TikTok para verificar qualidade do corte e da legenda pública.
