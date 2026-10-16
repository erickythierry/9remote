# 9Remote Mobile (Self-Hosted)

Aplicativo Android (Expo / React Native) para o 9Remote, adaptado para operar em ambientes **100% self-hosted** (WireGuard / LAN local), sem qualquer dependência de servidores de terceiros ou serviços em nuvem.

---

## Recursos e Diferenciais do Fork

- **Configuração Dinâmica de Host**: Defina a URL do seu servidor local (ex: `http://10.8.0.2:2208`). O valor é salvo no `AsyncStorage` (`@9remote:custom_host`).
- **Cleartext Traffic Liberado**: Permite conexões HTTP puro na VPN ou rede local (`android:usesCleartextTraffic="true"`).
- **Ponte Nativa Completa**:
  - `HAPTIC`: Vibração com `expo-haptics`.
  - `THEME_CHANGE`: Ajuste de tema e cor da barra de status do Android.
  - `SET_SCREEN_ORIENTATION` / `GET_SCREEN_ORIENTATION`: Rotação de tela travada ou automática.
  - Injeção automática de `window.handleSafeAreaInset` (notch / status bar).
  - Injeção de `window.MOBILE_APP = true` e `window.DEVICE_INFO`.
- **Zero Telemetria e Zero Dependências Externas**:
  - Removido `expo-updates` (sem downloads OTA de terceiros).
  - Removido `expo-iap` (recursos Pro liberados por padrão no self-hosted).
  - Sem tráfego obrigatório para `9remote.cc`.

---

## Como Executar em Desenvolvimento

Dentro da pasta `expo/`:

```bash
# Iniciar servidor Metro
npm start

# Ou abrir direto no emulador/dispositivo Android conectado via USB/WiFi
npx expo run:android
```

---

## Como Gerar o APK de Produção

### Método 1: Build Local via Gradle (Recomendado se o Android SDK estiver instalado)

```bash
# 1. Gera a pasta nativa android/ com as permissões e configurações do app.json
npx expo prebuild --platform android

# 2. Compila o APK release
cd android && ./gradlew assembleRelease

# O APK gerado estará em:
# android/app/build/outputs/apk/release/app-release.apk
```

### Método 2: Build Standalone via EAS Build Local

```bash
# Instalar EAS CLI se necessário:
# npm install -g eas-cli

# Build local sem enviar código para servidores da Expo:
eas build --platform android --profile production --local
```

---

## Alterando o Host

- Na primeira inicialização, uma tela solicitará a URL do host (ex: `http://10.8.0.2:2208`).
- Para alterar o host a qualquer momento:
  - Toque no botão sutil no canto superior direito da tela, ou
  - Caso haja falha de conexão (ex: WireGuard desconectado), a tela de erro exibirá o botão **Alterar Host**.
