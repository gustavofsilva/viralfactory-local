# Worker de mídia

`worker.py` executa síntese Piper, timestamps de palavras com faster-whisper,
legendas ASS e cenas gráficas/composição de imagens com Pillow.

O ambiente virtual fica em **D:/ViralFactoryLocal/tools/python**, conforme
autorização e preferência do usuário. Modelos e resultados ficam no D.
`requirements.lock.txt` registra as versões validadas em Windows/Python 3.13.
PyAV 15.1.0 está fixado porque a versão 19 removeu um argumento usado pelo
faster-whisper 1.2.1.

Execução por JSON de entrada/saída:

```text
python worker.py tts --request input.json --response output.json
python worker.py subtitles --request input.json --response output.json
python worker.py card --request input.json --response output.json
```

Node coordena subprocessos sem shell, com timeout e cancelamento da árvore de
processos. Áudio usa arquivo temporário e troca atômica. Os arquivos e estados
de cada etapa são persistidos para retomada. FFmpeg compõe o MP4 e ffprobe
verifica resolução, codecs e duração no backend.
