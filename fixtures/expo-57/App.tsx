import { useEffect } from "react";
import { Button, SafeAreaView, Text, View, AppState, StyleSheet } from "react-native";
import {
  TelemetryErrorBoundary,
  createScreenTracker,
  initReactNativeTelemetry,
} from "@davidapps/telemetry-react-native";
import { createExpoTelemetryResource } from "@davidapps/telemetry-react-native/expo";

const endpoint = process.env.EXPO_PUBLIC_TELEMETRY_ENDPOINT ?? "http://localhost:4318";

const telemetry = initReactNativeTelemetry({
  endpoint,
  enabled: Boolean(process.env.EXPO_PUBLIC_TELEMETRY_ENDPOINT),
  debug: __DEV__,
  resource: createExpoTelemetryResource({
    serviceName: "telemetry-expo-57-fixture",
    environment: __DEV__ ? "development" : "production",
    commitSha: process.env.EXPO_PUBLIC_GIT_SHA,
  }),
  appState: AppState,
  fetch: {
    propagateTraceHeadersTo: ["https://api.davidapps.dev/"],
  },
});

const screens = createScreenTracker(telemetry.client);

function FixtureScreen() {
  useEffect(() => {
    screens.track("FixtureHome");
    telemetry.startup.markInteractive({ "screen.name": "FixtureHome" });
  }, []);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>DavidApps telemetry</Text>
        <Text style={styles.copy}>Expo 57 / React Native 0.86.2 integration fixture</Text>
        <Button
          title="Capture test event"
          onPress={() => telemetry.client.capture("fixture.button_pressed")}
        />
        <Button
          title="Fetch traced request"
          onPress={() => void fetch("https://api.davidapps.dev/health")}
        />
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <TelemetryErrorBoundary
      client={telemetry.client}
      fallback={<Text>Something went wrong.</Text>}
    >
      <FixtureScreen />
    </TelemetryErrorBoundary>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#0f172a",
  },
  card: {
    gap: 16,
    borderRadius: 16,
    padding: 24,
    backgroundColor: "#f8fafc",
  },
  title: {
    color: "#0f172a",
    fontSize: 24,
    fontWeight: "700",
  },
  copy: {
    color: "#475569",
    fontSize: 16,
  },
});
