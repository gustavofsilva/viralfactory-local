# CODEX — VIRALFACTORY LOCAL
## Plataforma gratuita e automatizada de vídeos virais

Você é um arquiteto de software sênior especializado em TypeScript, Node.js, React, Python, inteligência artificial local, FFmpeg, automação e processamento multimídia.

Desenvolva uma aplicação funcional chamada **ViralFactory Local**.

O objetivo é criar uma fábrica de vídeos curtos para TikTok e YouTube Shorts que rode no meu computador Windows, automatizando desde a descoberta de assuntos virais até a geração do MP4 final e, quando permitido, a publicação.

## REQUISITOS FUNDAMENTAIS

1. Priorizar ferramentas gratuitas, open source e executadas localmente.
2. Não depender de APIs pagas de IA.
3. Permitir pesquisar assuntos virais de todas as categorias.
4. Gerar vídeos em português brasileiro.
5. Produzir vídeos originais, evitando cópias de conteúdo de terceiros.
6. Utilizar minha GeForce GTX 1650 quando houver aceleração compatível.
7. Permitir processamento por CPU como alternativa.
8. Não exigir Docker para executar o MVP.
9. Armazenar tudo localmente.
10. Ter interface web completa.
11. Permitir configurar a quantidade diária de vídeos.
12. Funcionar inicialmente em modo semiautomático.
13. Não depender da aprovação de APIs de publicação para gerar vídeos.
14. Preservar progresso mesmo depois de reiniciar o computador.
15. Nunca simular uma integração como se fosse real.

## 1. ARQUITETURA

Utilize um monorepo contendo:

- apps/web — React, Vite, TypeScript e Tailwind CSS.
- apps/api — Node.js, TypeScript e Fastify.
- workers/media — Python para TTS, transcrição e tarefas específicas.
- packages/shared — tipos, validação e contratos.
- data — SQLite, arquivos de vídeo, áudios e cache.
- scripts — instalação, inicialização e diagnóstico.

Banco de dados: SQLite com Prisma.

Filas: utilize uma fila persistente baseada em SQLite, com leasing, retries, timestamps e recuperação de jobs interrompidos.

Evite Redis e PostgreSQL no MVP.

Agendamento: node-cron combinado com persistência no banco e mecanismos para impedir execuções duplicadas.

Edição: FFmpeg como motor principal, com Remotion opcional para layouts mais sofisticados.

Use subprocessos seguros, controlados e monitorados.

## 2. INTELIGÊNCIA ARTIFICIAL LOCAL

Utilize Ollama:

https://ollama.com/

Configure inicialmente o modelo `qwen3:4b`, caso esteja disponível no catálogo oficial.

Se o desempenho for insuficiente, disponibilize alternativas menores, incluindo `llama3.2:3b` e variantes Qwen menores efetivamente disponíveis.

Requisitos:

- Detecção automática do Ollama.
- Instalação guiada de modelos.
- Verificação de memória disponível.
- Configuração de contexto conservadora.
- Apenas uma geração de texto por vez inicialmente.
- Timeout configurável.
- Resposta obrigatória em JSON estruturado.
- Validação do JSON com Zod.
- Retry quando houver JSON inválido.
- Cache dos resultados.

Utilize a IA para:

- Classificação de tendências.
- Agrupamento de notícias semelhantes.
- Resumo de fontes.
- Geração de roteiros.
- Criação de títulos.
- Sugestões de cenas.
- Descrições.
- Hashtags.
- Verificação de consistência entre roteiro e fontes.

Nunca utilize a memória interna do modelo como prova de um acontecimento recente.

O modelo deve trabalhar com informações efetivamente coletadas e datadas.

## 3. PESQUISA AUTOMÁTICA DE ASSUNTOS VIRAIS

Implemente conectores independentes para:

### Google News
Utilizar feeds RSS disponíveis e permitidos.

### GDELT
Utilizar endpoints públicos e documentação oficial para identificar cobertura de acontecimentos.

### Reddit
Utilizar API oficial quando disponível e autorizada, respeitando as regras aplicáveis.

### YouTube
Utilizar a YouTube Data API para descobrir vídeos relevantes e sinais de popularidade disponíveis.

Nunca presumir que a API fornece uma lista universal e confiável dos assuntos mais virais.

### Wikimedia
Utilizar os dados públicos de visualizações de páginas para identificar temas em crescimento.

### Sites de notícias
Implementar leitor genérico de RSS.

Permitir configurar manualmente fontes como portais de notícias, tecnologia, jogos, ciência, entretenimento e esportes.

### Google Trends
Implementar integração somente por meios permitidos, se houver acesso adequado.

A API oficial possui requisitos de acesso que devem ser verificados.

### TikTok
Investigar meios oficiais de acesso a tendências.

Não utilizar scraping não autorizado, cookies de sessão extraídos ou bypass de proteções.

Quando não houver integração viável, criar módulo para importar links e tendências manualmente.

Todos os conectores devem permitir habilitar, desabilitar, testar conexão e visualizar erros.

## 4. IDENTIFICAÇÃO DOS MELHORES ASSUNTOS

Quero descobrir qualquer assunto que esteja viralizando, não apenas notícias.

Categorias possíveis:

- Notícias.
- Tecnologia.
- Inteligência artificial.
- Games.
- Ciência.
- Curiosidades.
- Entretenimento.
- Celebridades.
- Futebol.
- Esportes.
- Memes.
- História.
- Mistérios.
- Cultura pop.
- Assuntos internacionais.
- Outros temas emergentes.

Crie um mecanismo de ranking que considere popularidade observada, crescimento, recência, relevância para o Brasil e disponibilidade de fontes confiáveis.

Use uma pontuação de 0 a 100 com fatores transparentes.

Não invente curtidas, visualizações, compartilhamentos ou volume de pesquisas.

Armazene múltiplas observações ao longo do tempo para detectar crescimento.

Agrupe matérias sobre o mesmo fato.

Não gere vídeos duplicados sobre o mesmo acontecimento.

Permita selecionar os assuntos automaticamente ou manualmente.

## 5. VERIFICAÇÃO DE FATOS

Antes de gerar um vídeo:

1. Reunir informações de fontes verificáveis.
2. Identificar data de publicação e data do acontecimento.
3. Procurar confirmação independente quando necessário.
4. Separar fatos de rumores e opiniões.
5. Recusar afirmações sem suporte suficiente.
6. Registrar fontes usadas no roteiro.

Para assuntos sensíveis, como acidentes, saúde, crimes e alegações sobre pessoas reais, exigir aprovação humana.

Nunca criar citações falsas, acusações inventadas ou detalhes não verificados.

## 6. CRIAÇÃO DOS ROTEIROS

Crie vídeos com duração configurável entre 15 e 90 segundos.

Padrão: 35 a 45 segundos.

Cada roteiro deve conter:

- Gancho inicial forte.
- Contextualização breve.
- Desenvolvimento.
- Detalhe interessante.
- Encerramento.

Utilize português brasileiro natural.

Crie também:

- Título.
- Descrição.
- Hashtags.
- Texto de capa.
- Lista de cenas.
- Prompts ou consultas para imagens.
- Fontes.
- Duração aproximada.

Não utilize clickbait enganoso.

Configure estilos de roteiro: jornalístico, curioso, descontraído, storytelling e gamer.

## 7. NARRAÇÃO LOCAL

Utilize Piper TTS com modelo pt_BR.

Links de referência:

https://github.com/OHF-Voice/piper1-gpl

https://github.com/rhasspy/piper

Investigue o projeto mantido, as vozes disponíveis e a licença específica de cada modelo.

Crie adaptador de TTS para permitir substituição futura.

Funcionalidades:

- Escolher voz.
- Gerar WAV.
- Ajustar velocidade.
- Ouvir prévia.
- Gerar novamente.
- Cache por texto, modelo e configuração.
- Permitir importar uma narração externa.

Se a qualidade de determinada voz for insatisfatória, permitir trocar por outro modelo local compatível e licenciado.

Não pressupor que todos os modelos de voz autorizam uso comercial.

## 8. LEGENDAS

Utilize faster-whisper ou whisper.cpp.

Comece com modelo pequeno, usando CPU quando for mais conveniente.

Para sincronizar:

1. Gerar áudio.
2. Processar o áudio com ferramenta de alinhamento ou reconhecimento.
3. Obter timestamps.
4. Criar legendas por palavras ou pequenos grupos.
5. Gerar arquivo ASS.
6. Renderizar legendas no FFmpeg.

O sistema deve permitir escolher cor, fonte, tamanho e posição.

A sincronização não deve ser estimada apenas dividindo igualmente a duração da narração.

## 9. MATERIAIS VISUAIS

Implementar provedores:

- Pexels.
- Pixabay.
- Wikimedia Commons.
- Biblioteca local.
- Fundos e animações gerados programaticamente.

Priorizar materiais que possam ser utilizados legalmente em vídeos publicados e monetizados.

Registrar:

- URL de origem.
- Autor.
- Licença.
- Necessidade de atribuição.
- Restrições.
- Data de aquisição.

Quando o material não tiver licença adequada, não utilizá-lo.

Não copiar vídeos inteiros do TikTok ou YouTube.

Se nenhuma imagem adequada existir, gerar uma cena visual usando gráficos, textos, fundos animados ou elementos próprios.

Criar cache dos arquivos baixados.

## 10. EDITOR DE VÍDEOS AUTOMÁTICO

Utilizar FFmpeg.

Configuração inicial:

- Resolução 1080x1920.
- Proporção 9:16.
- 30 FPS.
- H.264.
- AAC.
- MP4.
- Vídeos de 35 a 45 segundos.
- Bitrate configurável.
- Loudness normalizado.

Criar cenas sincronizadas com a narração.

Recursos:

- Zoom progressivo.
- Movimento horizontal e vertical.
- Cortes entre cenas.
- Transições discretas.
- Legendas animadas.
- Destaque de palavras.
- Música de fundo opcional.
- Ducking.
- Capa automática.
- Marca visual própria opcional, respeitando regras das plataformas.

Usar NVENC somente se a GPU e o FFmpeg oferecerem suporte real ao encoder selecionado.

Se não houver suporte, usar libx264.

Não exigir renderização por GPU.

Criar três templates iniciais: Notícias, Viral e Curiosidades.

## 11. DASHBOARD

Criar interface moderna em português.

Telas:

### Visão geral
Exibir tendências, vídeos produzidos, trabalhos em execução e erros.

### Tendências
Exibir ranking, fontes, data e botão de gerar vídeo.

### Estúdio
Permitir editar roteiro, trocar narração, imagens, legendas e template.

### Fila
Mostrar cada etapa da produção e permitir cancelar ou repetir tarefas.

### Biblioteca
Exibir vídeos prontos, prévias, arquivos, títulos e descrições.

### Calendário
Agendar produção e publicação.

### Publicação
Mostrar status de cada plataforma e permitir baixar vídeo e copiar metadados.

### Configurações
Configurar IA, TTS, modelos, diretórios, pesquisas, horários, templates e contas.

## 12. AUTOMAÇÃO

Criar três modos:

### Manual
Eu seleciono os assuntos e inicio a produção.

### Semiautomático
O sistema seleciona tendências, gera vídeos e deixa tudo aguardando minha aprovação.

### Automático
O sistema publica os vídeos somente se existir integração autorizada e apta a realizar a operação.

O modo inicial deve ser semiautomático.

Configuração padrão:

- Pesquisa de tendências: a cada 60 minutos.
- Seleção diária: até 5 assuntos.
- Produção diária: até 3 vídeos.
- Renderizações simultâneas: 1.
- Gerações de texto simultâneas: 1.
- Duração: 35 a 45 segundos.
- Idioma: pt-BR.
- Região prioritária: Brasil.
- Categoria: todas.
- Publicação automática: desabilitada.

Não publicar automaticamente conteúdo que tenha problemas de licença, fontes insuficientes ou sinalização de risco.

## 13. PUBLICAÇÃO

Implementar arquitetura com interfaces de publicação independentes.

### YouTube Shorts
Investigar e utilizar OAuth 2.0 e YouTube Data API.

Implementar upload resumível, metadados, privacidade, status, tratamento de cotas e agendamento permitido.

Respeitar auditorias e restrições aplicáveis ao projeto.

### TikTok
Investigar e implementar a Content Posting API oficial.

Implementar OAuth, consentimento explícito, metadados, upload e consulta de status.

Não prometer publicação pública sem aprovação e permissões necessárias.

### Plano alternativo manual
Se a integração não estiver autorizada:

- Gerar MP4.
- Preparar título e descrição.
- Preparar hashtags.
- Criar botão para copiar metadados.
- Criar botão de download.
- Exibir checklist de publicação.
- Permitir marcar como publicado e inserir URL.

Não utilizar automação que contorne mecanismos de segurança das plataformas.

## 14. EXECUÇÃO NO WINDOWS

O projeto precisa funcionar em Windows 10 ou 11.

Criar:

- install.ps1
- start.ps1
- stop.ps1
- doctor.ps1
- .env.example
- README.md
- ARCHITECTURE.md
- PROGRESS.md

O script doctor.ps1 deve verificar:

- Node.js.
- Python.
- FFmpeg.
- Ollama.
- Modelo de linguagem.
- Piper.
- Voz pt-BR.
- Whisper.
- SQLite.
- NVIDIA GPU.
- Encoder NVENC.
- Espaço em disco.
- Memória disponível.

Não executar instalações globais ou alterar configurações de segurança do Windows silenciosamente.

Solicitar autorização antes de instalações ou alterações persistentes.

Priorizar dependências dentro do projeto.

## 15. RESILIÊNCIA

Todas as etapas devem salvar seu resultado.

Pipeline:

DISCOVERED
→ RESEARCHED
→ SCRIPTED
→ AUDIO_READY
→ MEDIA_READY
→ SUBTITLES_READY
→ RENDERED
→ REVIEW_PENDING
→ APPROVED
→ PUBLISHING
→ PUBLISHED

Também implementar estados FAILED, CANCELED e RETRY_PENDING.

Permitir continuar trabalhos interrompidos.

Armazenar logs, tentativas e causas de erro.

Não produzir vídeos duplicados após reinicialização.

## 16. DESEMPENHO

O ambiente inicial possui uma NVIDIA GTX 1650.

Como a quantidade de RAM e o modelo do processador ainda não foram informados, detecte essas informações antes de selecionar modelos definitivos.

Evite modelos de vídeo generativo pesados.

Não tente executar vários modelos grandes simultaneamente.

Priorize:

- Ollama com modelo pequeno quantizado.
- Piper para áudio.
- Whisper pequeno.
- FFmpeg para composição.
- Processamento sequencial.
- Reaproveitamento de cache.

Permita configuração de baixa memória.

## 17. TESTE REAL OBRIGATÓRIO

A primeira entrega funcional deve permitir:

1. Abrir o dashboard.
2. Executar uma pesquisa real de tendências.
3. Visualizar assuntos encontrados.
4. Escolher um assunto.
5. Reunir fontes.
6. Gerar roteiro com Ollama.
7. Gerar áudio com Piper.
8. Buscar materiais visuais licenciados.
9. Produzir legendas.
10. Renderizar um MP4.
11. Assistir à prévia.
12. Baixar o vídeo final.

Não utilize resultados falsos para demonstrar a conclusão.

Se houver alguma dependência externa bloqueando uma etapa, informe claramente e continue o desenvolvimento das demais.

## 18. ORDEM DE IMPLEMENTAÇÃO

Desenvolva incrementalmente:

Fase 1 — Estrutura, SQLite, backend e frontend.

Fase 2 — Conectores de tendências reais e ranking.

Fase 3 — Integração Ollama, pesquisa e roteiros.

Fase 4 — Piper TTS e sincronização de legendas.

Fase 5 — Busca de mídia e renderização FFmpeg.

Fase 6 — Editor e visualização dos vídeos.

Fase 7 — Agendamento e execução automática.

Fase 8 — Integrações oficiais de publicação.

Fase 9 — Analytics, histórico e otimizações.

A prioridade absoluta é concluir um pipeline local funcional antes de adicionar funcionalidades secundárias.

Faça testes após cada fase.

Documente o progresso real no arquivo PROGRESS.md, incluindo o que ainda falta e como retomar o desenvolvimento em outra sessão do Codex.

## INSTRUÇÃO FINAL

Inspecione primeiro o diretório atual e as ferramentas disponíveis no computador.

Crie o projeto se ele ainda não existir.

Implemente as funcionalidades, não apenas a arquitetura.

Sempre prefira soluções gratuitas e locais.

Evite dependências desnecessárias, principalmente serviços pagos, servidores externos, Docker obrigatório e infraestrutura complexa.

Tome decisões técnicas razoáveis sem solicitar confirmação para detalhes triviais.

Quando uma funcionalidade exigir autorização, credenciais ou aprovação externa, implemente sua interface e forneça instruções claras de configuração.

Comece imediatamente a implementação da Fase 1 e avance conforme conseguir testar cada componente.
