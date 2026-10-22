import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  BackHandler,
  Modal,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Animated,
  PanResponder,
  useWindowDimensions,
  ScrollView
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import * as ScreenOrientation from "expo-screen-orientation";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

const STORAGE_HOST_KEY = "@9remote:custom_host";
const STORAGE_POS_KEY = "@9remote:fab_position";
const DEFAULT_HOST = "http://10.8.0.2:2208";
const FAB_SIZE = 30;
type PositionPreset = "mid-right" | "mid-left" | "bottom-right" | "bottom-left" | "top-left";

type BridgeMessage =
  | { type: "HAPTIC"; style?: unknown }
  | { type: "THEME_CHANGE"; theme?: unknown }
  | { type: "SET_SCREEN_ORIENTATION"; orientation?: unknown }
  | { type: "GET_SCREEN_ORIENTATION" }
  | { type: "OPEN_BROWSER"; url?: unknown }
  | { type: "IAP_GET_ENTITLEMENT" }
  | { type: "SHOW_PAYWALL" }
  | { type: "REQUEST_PUSH_TOKEN" };

function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;

  return typeof value.type === "string" && [
    "HAPTIC",
    "THEME_CHANGE",
    "SET_SCREEN_ORIENTATION",
    "GET_SCREEN_ORIENTATION",
    "OPEN_BROWSER",
    "IAP_GET_ENTITLEMENT",
    "SHOW_PAYWALL",
    "REQUEST_PUSH_TOKEN",
  ].includes(value.type);
}

function MainScreen() {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const webViewRef = useRef<WebView>(null);

  const [hostUrl, setHostUrl] = useState<string | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [inputHost, setInputHost] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [canGoBack, setCanGoBack] = useState(false);

  // Posição padrão do indicador: lateral direita a 45% da altura (longe do topo e rodapé)
  const getDefaultPos = useCallback(
    (w = windowWidth, h = windowHeight, ins = insets) => ({
      x: Math.max(10, (w || 360) - FAB_SIZE - 12),
      y: Math.max((ins?.top || 24) + 60, Math.round((h || 640) * 0.45)),
    }),
    [windowWidth, windowHeight, insets]
  );

  const pan = useRef(
    new Animated.ValueXY({
      x: windowWidth > 0 ? windowWidth - FAB_SIZE - 12 : 320,
      y: windowHeight > 0 ? Math.round(windowHeight * 0.45) : 300,
    })
  ).current;

  const currentPos = useRef({
    x: windowWidth > 0 ? windowWidth - FAB_SIZE - 12 : 320,
    y: windowHeight > 0 ? Math.round(windowHeight * 0.45) : 300,
  });

  useEffect(() => {
    const idX = pan.x.addListener((v) => {
      currentPos.current.x = v.value;
    });
    const idY = pan.y.addListener((v) => {
      currentPos.current.y = v.value;
    });
    return () => {
      pan.x.removeListener(idX);
      pan.y.removeListener(idY);
    };
  }, [pan]);

  // Carrega posição persistida do botão
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_POS_KEY);
        if (saved) {
          const { x, y } = JSON.parse(saved);
          const maxX = (windowWidth || 360) - FAB_SIZE - 6;
          const maxY = (windowHeight || 640) - Math.max(insets.bottom, 6) - FAB_SIZE;
          const clampedX = Math.min(Math.max(6, x), maxX);
          const clampedY = Math.min(Math.max(Math.max(insets.top, 6), y), maxY);
          pan.setValue({ x: clampedX, y: clampedY });
        } else {
          pan.setValue(getDefaultPos());
        }
      } catch (e) {
        pan.setValue(getDefaultPos());
      }
    })();
  }, [windowWidth, windowHeight, insets, getDefaultPos, pan]);

  // PanResponder para permitir arrastar o botão livremente pela tela
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        return Math.abs(gestureState.dx) > 3 || Math.abs(gestureState.dy) > 3;
      },
      onPanResponderGrant: () => {
        pan.setOffset({
          x: currentPos.current.x,
          y: currentPos.current.y,
        });
        pan.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: (evt, gestureState) => {
        pan.flattenOffset();
        // Se movimentou menos de 6px, foi apenas um toque/click
        if (Math.hypot(gestureState.dx, gestureState.dy) < 6) {
          Haptics.selectionAsync();
          setModalVisible(true);
          return;
        }

        // Se foi arrastado, limita aos limites da tela
        const minX = 6;
        const maxX = (windowWidth || 360) - FAB_SIZE - 6;
        const minY = Math.max(insets.top, 6);
        const maxY = (windowHeight || 640) - Math.max(insets.bottom, 6) - FAB_SIZE;

        const finalX = Math.min(Math.max(minX, currentPos.current.x), maxX);
        const finalY = Math.min(Math.max(minY, currentPos.current.y), maxY);

        Animated.spring(pan, {
          toValue: { x: finalX, y: finalY },
          useNativeDriver: false,
          friction: 7,
        }).start();

        AsyncStorage.setItem(
          STORAGE_POS_KEY,
          JSON.stringify({ x: finalX, y: finalY })
        ).catch(() => {});
      },
      onPanResponderTerminate: () => {
        pan.flattenOffset();
      },
    })
  ).current;

  // Reposicionar para preset
  const moveToPreset = (preset: PositionPreset) => {
    let target = getDefaultPos();
    if (preset === "mid-left") {
      target = {
        x: 10,
        y: Math.max(insets.top + 60, Math.round(windowHeight * 0.45)),
      };
    } else if (preset === "bottom-right") {
      target = {
        x: windowWidth - FAB_SIZE - 12,
        y: windowHeight - Math.max(insets.bottom, 16) - FAB_SIZE - 20,
      };
    } else if (preset === "bottom-left") {
      target = {
        x: 10,
        y: windowHeight - Math.max(insets.bottom, 16) - FAB_SIZE - 20,
      };
    } else if (preset === "top-left") {
      target = {
        x: 10,
        y: Math.max(insets.top, 8) + 8,
      };
    }

    Animated.spring(pan, {
      toValue: target,
      useNativeDriver: false,
      friction: 7,
    }).start();
    AsyncStorage.setItem(STORAGE_POS_KEY, JSON.stringify(target)).catch(() => {});
    Haptics.selectionAsync();
  };

  // Carrega host persistido
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_HOST_KEY);
        if (saved && saved.trim()) {
          setHostUrl(saved.trim());
          setInputHost(saved.trim());
        } else {
          setInputHost(DEFAULT_HOST);
          setModalVisible(true);
        }
      } catch (e) {
        setInputHost(DEFAULT_HOST);
        setModalVisible(true);
      } finally {
        setLoadingInitial(false);
      }
    })();
  }, []);

  // Botão voltar do Android
  useEffect(() => {
    const onBackPress = () => {
      if (modalVisible) {
        if (hostUrl) setModalVisible(false);
        return true;
      }
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [canGoBack, modalVisible, hostUrl]);

  // Salvar novo host
  const handleSaveHost = async () => {
    let clean = inputHost.trim();
    if (!clean) {
      Alert.alert("URL Obrigatória", "Informe o endereço do host 9Remote (ex: http://10.8.0.2:2208).");
      return;
    }
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
      clean = "http://" + clean;
    }
    // Remove trailing slash
    clean = clean.replace(/\/+$/, "");

    try {
      await AsyncStorage.setItem(STORAGE_HOST_KEY, clean);
      setHostUrl(clean);
      setLoadError(null);
      setConnectionStatus("connecting");
      setModalVisible(false);
      Haptics.selectionAsync();
    } catch (e) {
      Alert.alert("Erro", "Falha ao salvar configurações.");
    }
  };

  // Injeção de insets
  useEffect(() => {
    if (webViewRef.current && insets) {
      const js = `window.handleSafeAreaInset && window.handleSafeAreaInset(${insets.top}, ${insets.left}, ${insets.right}); true;`;
      webViewRef.current.injectJavaScript(js);
    }
  }, [insets]);

  // Mensagens da ponte nativa (handleWebViewMessage)
  const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
    try {
      const parsed: unknown = JSON.parse(event.nativeEvent.data);
      if (!isBridgeMessage(parsed)) return;
      const data = parsed;

      switch (data.type) {
        case "HAPTIC":
          if (data.style === "selection") {
            Haptics.selectionAsync();
          } else if (data.style === "heavy") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          } else if (data.style === "medium") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          } else {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
          break;

        case "THEME_CHANGE":
          if (data.theme === "light" || data.theme === "dark") {
            setTheme(data.theme);
          }
          break;

        case "SET_SCREEN_ORIENTATION":
          if (data.orientation === "portrait") {
            ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
          } else if (data.orientation === "auto") {
            ScreenOrientation.unlockAsync();
          }
          break;

        case "GET_SCREEN_ORIENTATION": {
          const current = await ScreenOrientation.getOrientationAsync();
          const isLandscape =
            current === ScreenOrientation.Orientation.LANDSCAPE_LEFT ||
            current === ScreenOrientation.Orientation.LANDSCAPE_RIGHT;
          const ori = isLandscape ? "landscape" : "portrait";
          webViewRef.current?.injectJavaScript(
            `window.handleScreenOrientationChange && window.handleScreenOrientationChange("${ori}"); true;`
          );
          break;
        }

        case "OPEN_BROWSER":
          if (data.url) {
            WebBrowser.openBrowserAsync(data.url as string).catch(() => {});
          }
          break;

        case "IAP_GET_ENTITLEMENT":
        case "SHOW_PAYWALL":
          // Em modo self-hosted, todos os recursos Pro são liberados
          webViewRef.current?.injectJavaScript(`
            window.handleIAPEvent && window.handleIAPEvent({
              kind: "entitlement",
              entitlement: { plan: "pro_yearly", status: "active", expiresAt: null }
            });
            true;
          `);
          break;

        case "REQUEST_PUSH_TOKEN":
          // Notificações em self-hosted ocorrem via WebSocket/foreground service
          break;

        default:
          break;
      }
    } catch (e) {
      // Ignora mensagens que não são JSON
    }
  }, []);

  // Script injetado antes do DOM carregar
  const injectedBefore = `
    (function() {
      if (/Android/i.test(navigator.userAgent)) {
        try {
          Object.defineProperty(document.documentElement.style, "transform", {
            set: function() {},
            get: function() { return ""; },
            configurable: true
          });
        } catch (e) {}
      }
      true;
    })();
  `;

  // Script injetado no carregamento
  const handleLoadEnd = () => {
    setLoadError(null);
    setConnectionStatus("connected");
    const script = `
      (function() {
        window.MOBILE_APP = true;
        window.MOBILE_APP_TYPE = "expo";
        window.DEVICE_INFO = {
          platform: 'android',
          version: '2.4.3',
          userAgent: '9Remote-Mobile/2.4.3'
        };
        window.handleAppStateChange && window.handleAppStateChange(true);
        if (window.handleSafeAreaInset) {
          window.handleSafeAreaInset(${insets.top}, ${insets.left}, ${insets.right});
        }
        true;
      })();
    `;
    webViewRef.current?.injectJavaScript(script);
  };

  if (loadingInitial) {
    return (
      <View style={[styles.container, styles.center, { backgroundColor: "#0b0d0c" }]}>
        <ActivityIndicator size="large" color="#E56A4A" />
      </View>
    );
  }

  const isDark = theme === "dark";
  const bgColor = isDark ? "#0b0d0c" : "#FCFBF9";

  const dotColor =
    connectionStatus === "connected"
      ? "#22c55e"
      : connectionStatus === "error"
      ? "#ef4444"
      : "#E56A4A";

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <StatusBar style={isDark ? "light" : "dark"} backgroundColor={bgColor} />

      {hostUrl && !loadError ? (
        <View style={styles.webviewContainer}>
          <WebView
            ref={webViewRef}
            source={{ uri: `${hostUrl}/login` }}
            style={[styles.webview, { backgroundColor: bgColor }]}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            startInLoadingState={true}
            allowsBackForwardNavigationGestures={true}
            userAgent="9Remote-Mobile/2.4.3"
            pullToRefreshEnabled={true}
            allowsInlineMediaPlayback={true}
            mediaPlaybackRequiresUserAction={false}
            mixedContentMode="always"
            injectedJavaScriptBeforeContentLoaded={injectedBefore}
            onLoadStart={() => setConnectionStatus("connecting")}
            onLoadEnd={handleLoadEnd}
            onMessage={handleMessage}
            onNavigationStateChange={(nav) => {
              setCanGoBack(nav.canGoBack);
              if (nav.loading) {
                setConnectionStatus("connecting");
              } else if (!loadError) {
                setConnectionStatus("connected");
              }
            }}
            onError={(e) => {
              setConnectionStatus("error");
              setLoadError(e.nativeEvent.description || "Falha de conexão");
            }}
            onHttpError={(e) => {
              if (e.nativeEvent.statusCode >= 500) {
                setConnectionStatus("error");
                setLoadError(`Erro HTTP ${e.nativeEvent.statusCode}`);
              }
            }}
          />

          {/* Botão flutuante arrastável: indicador de status e atalho de configuração */}
          <Animated.View
            {...panResponder.panHandlers}
            style={[
              styles.fabConfig,
              {
                transform: pan.getTranslateTransform(),
              },
            ]}
          >
            <View style={[styles.fabDot, { backgroundColor: dotColor }]} />
          </Animated.View>
        </View>
      ) : (
        <View style={[styles.center, styles.errorContainer]}>
          <Text style={styles.errorTitle}>9Remote Local</Text>
          <Text style={styles.errorMessage}>
            {loadError || "Nenhum host configurado."}
          </Text>
          <Text style={styles.errorSub}>
            Host atual: {hostUrl || "nenhum"}
          </Text>

          <View style={styles.row}>
            {hostUrl && (
              <TouchableOpacity
                style={[styles.btn, styles.btnSecondary]}
                onPress={() => {
                  setLoadError(null);
                  webViewRef.current?.reload();
                }}
              >
                <Text style={styles.btnSecondaryText}>Tentar Novamente</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={() => setModalVisible(true)}
            >
              <Text style={styles.btnPrimaryText}>Alterar Host</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Modal de Configuração de Host */}
      <Modal
        visible={modalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => {
          if (hostUrl) setModalVisible(false);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalBackdrop}
        >
          <SafeAreaView style={styles.modalCard}>
            <ScrollView
              contentContainerStyle={styles.modalScrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.modalHeaderRow}>
                <Text style={styles.modalTitle}>Configurar Host Local</Text>
                <View style={[styles.statusBadge, { backgroundColor: dotColor + "22", borderColor: dotColor + "55" }]}>
                  <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
                  <Text style={[styles.statusBadgeText, { color: dotColor }]}>
                    {connectionStatus === "connected"
                      ? "Conectado"
                      : connectionStatus === "error"
                      ? "Offline"
                      : "Conectando"}
                  </Text>
                </View>
              </View>
              <Text style={styles.modalDescription}>
                Informe o endereço do seu servidor 9Remote (ex: WireGuard ou IP da LAN):
              </Text>

              <TextInput
                style={styles.input}
                value={inputHost}
                onChangeText={setInputHost}
                placeholder="http://10.8.0.2:2208"
                placeholderTextColor="#666"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              {/* Seletor de Posição da Bolinha */}
              <View style={styles.positionSection}>
                <Text style={styles.positionSectionTitle}>Posição da Bolinha Indicadora</Text>
                <Text style={styles.positionSectionHint}>
                  💡 Você pode arrastar a bolinha com o dedo pela tela a qualquer momento, ou tocar num atalho:
                </Text>
                <View style={styles.presetRow}>
                  <TouchableOpacity
                    style={styles.btnPreset}
                    onPress={() => moveToPreset("mid-right")}
                  >
                    <Text style={styles.btnPresetText}>Meio Direito (Padrão)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.btnPreset}
                    onPress={() => moveToPreset("mid-left")}
                  >
                    <Text style={styles.btnPresetText}>Meio Esquerdo</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.presetRow}>
                  <TouchableOpacity
                    style={styles.btnPreset}
                    onPress={() => moveToPreset("bottom-right")}
                  >
                    <Text style={styles.btnPresetText}>Inferior Direito</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.btnPreset}
                    onPress={() => moveToPreset("bottom-left")}
                  >
                    <Text style={styles.btnPresetText}>Inferior Esquerdo</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.modalButtons}>
                {hostUrl ? (
                  <TouchableOpacity
                    style={[styles.btn, styles.btnCancel]}
                    onPress={() => setModalVisible(false)}
                  >
                    <Text style={styles.btnCancelText}>Cancelar</Text>
                  </TouchableOpacity>
                ) : null}

                <TouchableOpacity
                  style={[styles.btn, styles.btnSave]}
                  onPress={handleSaveHost}
                >
                  <Text style={styles.btnPrimaryText}>Salvar e Conectar</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1
  },
  webviewContainer: {
    flex: 1,
    position: "relative"
  },
  webview: {
    flex: 1
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24
  },
  fabConfig: {
    position: "absolute",
    top: 0,
    left: 0,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    backgroundColor: "rgba(18, 20, 24, 0.75)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.18)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 999,
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
  },
  fabDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
  },
  errorContainer: {
    backgroundColor: "#0b0d0c"
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#E56A4A",
    marginBottom: 8
  },
  errorMessage: {
    fontSize: 15,
    color: "#ededed",
    textAlign: "center",
    marginBottom: 4
  },
  errorSub: {
    fontSize: 13,
    color: "#888",
    textAlign: "center",
    marginBottom: 24
  },
  row: {
    flexDirection: "row",
    gap: 12
  },
  btn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center"
  },
  btnPrimary: {
    backgroundColor: "#E56A4A"
  },
  btnPrimaryText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15
  },
  btnSecondary: {
    backgroundColor: "#222",
    borderWidth: 1,
    borderColor: "#333"
  },
  btnSecondaryText: {
    color: "#ededed",
    fontWeight: "500",
    fontSize: 15
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#161817",
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: "#2a2d2b"
  },
  modalHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    gap: 6
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: "600"
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#ededed"
  },
  modalDescription: {
    fontSize: 14,
    color: "#9ca3af",
    marginBottom: 16,
    lineHeight: 20
  },
  input: {
    backgroundColor: "#0b0d0c",
    borderWidth: 1,
    borderColor: "#333",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#fff",
    fontSize: 15,
    marginBottom: 20
  },
  modalButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 12
  },
  btnCancel: {
    backgroundColor: "transparent",
    paddingHorizontal: 16
  },
  btnCancelText: {
    color: "#888",
    fontSize: 15
  },
  btnSave: {
    backgroundColor: "#E56A4A",
    minWidth: 140
  },
  modalScrollContent: {
    paddingBottom: 4
  },
  positionSection: {
    marginTop: 4,
    marginBottom: 20,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: "#262927"
  },
  positionSectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#ededed",
    marginBottom: 4
  },
  positionSectionHint: {
    fontSize: 12,
    color: "#888",
    marginBottom: 10,
    lineHeight: 16
  },
  presetRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 8
  },
  btnPreset: {
    flex: 1,
    backgroundColor: "#202322",
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#2f3331",
    alignItems: "center",
    justifyContent: "center"
  },
  btnPresetText: {
    fontSize: 12,
    color: "#cbd5e1",
    fontWeight: "500"
  }
});
