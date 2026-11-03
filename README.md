# Painel OBD para Android

Scanner automotivo OBD-II universal para adaptadores **ELM327 Bluetooth**.

## Baixar

**[⬇ Baixar PainelOBD.apk (versão mais nova)](https://github.com/lucaslbn08/painel-obd-android/releases/latest/download/PainelOBD.apk)**

## O que tem

- **Painel**: conta-giros, velocímetro, temperatura, combustível, carga, acelerador, luzes de aviso e 12 blocos de dados
- **Dados ao vivo**: tudo o que o carro informa, com mínimo/máximo e gráfico
- **Falhas**: códigos armazenados, pendentes e permanentes em português, apagar falhas e congelamento de dados
- **Prontidão**: autotestes de emissão (útil antes de vistoria)
- **Veículo**: chassi (VIN), protocolo, padrão OBD, tipo de combustível
- **Terminal**: comandos diretos ao adaptador
- **REC**: grava o trajeto em planilha CSV (Downloads/Painel OBD)
- **Viagens**: diário automático com distância, tempo, consumo e velocidades
- **Garagem**: hodômetro, abastecimentos (consumo real e custo por km) e lembretes de manutenção
- **Consumo** calculado mesmo em carros sem sensor de fluxo de ar (pela pressão do coletor e cilindrada)
- **Alertas** com voz, som e vibração (temperatura, bateria, nova falha, rotação, velocidade, manutenção)
- **Painel personalizável**, **conexão automática**, **relatório em imagem para o mecânico**
- **Desempenho**: 0–60, 0–100, 60–100 e 80–120 km/h
- **Modo HUD** espelhado para refletir no para-brisa
- **Exportar planilhas** (CSV) e **backup/restauração** de todos os dados
- **Demonstração**: carro simulado para conhecer o app

Funciona em qualquer carro com OBD-II (linha K, KWP2000, CAN, J1850). Não acessa ABS, airbag, chave ou câmbio de fábrica.

## Como funciona a compilação

A cada alteração enviada para a branch `main`, o GitHub Actions compila o APK e publica uma nova versão em *Releases*.
