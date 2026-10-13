# Multicontas e clipes de vídeos longos

Decisões de produto em 13/10/2026: os vídeos de origem serão **arquivos locais** (MP4/MOV) e cada conta TikTok usará **um perfil separado do Chrome**, autenticado pelo proprietário. A meta inicial é produzir clipes verticais de aproximadamente **60 a 90 segundos**, com sugestões automáticas de trechos e revisão antes do primeiro envio de cada clipe. A campanha atual de `@brasilgerais` continua na configuração antiga até a migração ser testada.

## Fluxo no painel

1. Em **Contas**, cadastrar um nome interno, o `@` esperado, a identidade visual, o texto de chamada para ação e os horários de cada conta. A conta atual `@brasilgerais` será migrada sem perder publicações ou agenda.
2. Abrir o perfil correspondente do Chrome, entrar no TikTok pessoalmente, visitar TikTok Studio e conectar a extensão. O painel mostra qual `@` foi identificado e a hora do último sinal. Uma conta pode estar offline sem pausar as outras.
3. Em **Clipes**, escolher um MP4/MOV local, informar título, origem/autorização de uso e conta de destino. O arquivo é copiado para `D:\ViralFactoryLocal\data\clips`, com limite configurável e validação por `ffprobe`; o aplicativo nunca tenta ler uma URL externa nem as sessões do Chrome.
4. O sistema extrai áudio e transcreve com o Whisper local. Segmenta o vídeo por pausas e mudanças de cena usando FFmpeg, pontua trechos com Ollama a partir da transcrição e propõe uma sequência de 60–90 s. Cada sugestão contém `in`, `out`, transcrição e motivo. A pontuação não pode inventar acontecimentos ausentes do vídeo.
5. O usuário assiste à prévia, altera a ordem e as bordas dos trechos e aprova o corte. A renderização preserva o áudio original, junta trechos com cortes discretos, ajusta para 1080×1920 sem cortar o assunto principal (fundo desfocado como opção segura), adiciona legendas sincronizadas, intro de 1 s, marca e chamada para ação da conta escolhida.
6. O clipe final recebe legenda editável e fica em rascunho. O usuário escolhe **Publicar agora** ou um horário da conta. Antes do upload, o servidor e a extensão conferem o `@` da aba conectada. Se o TikTok deixar o resultado incerto, apenas essa publicação entra em `UNKNOWN`, sem segunda tentativa automática.

## Isolamento entre contas

O banco terá `Account` (perfil, visual e preferências), `AccountConnection` (apenas identificadores e sinal de vida da extensão, sem cookies) e `Publication` (vídeo, conta, estado, horário, URL e evidência). Cada conexão da extensão fica vinculada a uma conta cadastrada e aceita comandos somente para o `@` confirmado na sua própria aba. O `AgentSlot` atual passa a referenciar uma conta; as chaves únicas de horários incluem o identificador da conta. Limites, fila, pausa e resultado incerto serão por conta, preservando a proteção contra post duplicado. Um mesmo clipe só poderá ir a mais de uma conta após uma escolha explícita no painel.

A extensão ganhará um seletor de conta no popup e uma conexão independente por perfil do Chrome. A seleção não muda a conta do TikTok: apenas declara qual conta cadastrada deve ser conferida. Se o `@` visível divergir, o upload será recusado. O token local da extensão continuará gerado no computador e fora do Git. Perfis diferentes podem usar a mesma instalação da extensão, com armazenamento de sessão separado pelo Chrome.

## Processamento dos clipes

- **Importação:** upload em fluxo para arquivo temporário no D, tamanho máximo explícito, extensão e codec inspecionados pelo `ffprobe`, hash SHA-256 para evitar cópias acidentais. O banco guarda caminho local, duração, resolução, áudio, origem e conta escolhida.
- **Sugestão:** transcrição com timestamps, detecção de pausas/cortes e análise local com Ollama. A saída precisa ser JSON validado: segmentos dentro da duração real, sem sobreposição, com mínimo de contexto e total de 60–90 s. Se o modelo falhar, o arquivo permanece importado para seleção manual.
- **Edição:** controles de início/fim por trecho, ordem, descarte, prévia e confirmação. A proposta automática nunca vai direto à postagem.
- **Renderização:** FFmpeg com áudio original e loudness controlado; formato vertical com enquadramento seguro, legendas, marca e intro configuráveis por conta. `ffprobe` valida duração, codec H.264/AAC e tamanho antes do envio. O encoder ajusta o bitrate para manter o arquivo final abaixo do limite atual de 40 MB da ponte de extensão. Arquivos intermediários e final ficam no D.
- **Publicação:** estado `DRAFT → APPROVED → QUEUED → SENDING → PUBLISHED` ou `UNKNOWN/BLOCKED`. A intenção de envio é persistida antes do clique. A fila verifica conta, arquivo e revisão outra vez imediatamente antes de publicar.

## Ordem de implementação e validação

1. **Base multicontas:** migração reversível, CRUD de contas, conexão da extensão por perfil e isolamento por conta. Validar com `@brasilgerais` e uma segunda conta de teste, sem alterar posts existentes. Impedir que uma conta envie o vídeo reservado à outra.
2. **Importação e editor de clipes:** upload local, transcrição, seleção automática, ajuste manual e renderização. Testar com um vídeo de origem autorizado, incluindo falha de transcrição e trechos sobrepostos. Conferir visualmente áudio, legenda e enquadramento.
3. **Fila de clipes:** seleção de conta, publicar agora/agendar, deduplicação e evidência de envio. Fazer o primeiro envio real só depois de conferir rascunho, identidade da conta e legenda. Manter a campanha de notícias independente.
4. **Ajustes de qualidade:** comparar sugestões com trechos escolhidos manualmente, melhorar ranking e, se necessário, adicionar detecção de pessoas para enquadramento. URLs externas e postagem pela API oficial ficam fora desta primeira versão.

## Critérios para concluir a primeira versão

- Duas contas aparecem simultaneamente no painel; cada uma mostra conexão, agenda e publicações próprias.
- Uma conexão de perfil errado jamais chega ao comando `UPLOAD` ou `SUBMIT`.
- Um MP4/MOV de origem gera sugestões de 60–90 s; o usuário consegue editar e gerar o clipe vertical com áudio e legendas.
- O arquivo final pode ser pré-visualizado, baixado e publicado na conta escolhida, com URL/evidência registrada e sem repetição de envio incerto.
- O código e os testes passam, e a instalação em outro computador continua usando o disco D para dados e ferramentas.

## Caminho futuro: API oficial

O TikTok oferece Direct Post mediante aplicativo registrado, autorização da conta e escopo `video.publish`. Um cliente ainda não auditado pode ter visibilidade restrita; por isso a primeira versão continuará com a extensão e perfis separados. A arquitetura de `Publication` deve permitir trocar o método de envio depois, sem refazer o editor de clipes. Consulte a [documentação de Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-get-started) e a [referência da API](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post).
