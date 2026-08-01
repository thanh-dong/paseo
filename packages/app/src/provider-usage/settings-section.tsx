import { RefreshCw } from "lucide-react-native";
import { useCallback, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { providerUsageCopy } from "./copy";
import { ProviderUsageList } from "./list";
import type { ProviderUsageView } from "./types";

export function ProviderUsageSettingsSection({
  serverId,
  view,
  onRefresh,
}: {
  serverId: string;
  view: ProviderUsageView;
  onRefresh: () => void;
}) {
  const busy = view.kind === "loading" || (view.kind === "ready" && view.isRefreshing);
  const supportsAutoResume = useHostFeature(serverId, "autoResumeOnLimit");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const autoResumeEnabled = config?.autoResumeOnLimit?.enabled === true;
  const autoResumeMutation = useMutation({
    mutationFn: async (next: boolean) => {
      const result = await patchConfig({
        autoResumeOnLimit: {
          enabled: next,
        },
      });
      if (!result) {
        throw new Error(providerUsageCopy.clientUnavailable);
      }
      return result;
    },
  });
  const handleAutoResumeToggle = useCallback(() => {
    autoResumeMutation.mutate(!autoResumeEnabled);
  }, [autoResumeEnabled, autoResumeMutation]);

  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={RefreshCw}
        loading={busy}
        onPress={onRefresh}
        accessibilityLabel={providerUsageCopy.refresh}
      >
        {busy ? providerUsageCopy.refreshing : providerUsageCopy.refresh}
      </Button>
    ),
    [busy, onRefresh],
  );

  return (
    <SettingsSection
      title={providerUsageCopy.title}
      testID="provider-usage-card"
      trailing={refreshButton}
    >
      {supportsAutoResume ? (
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{providerUsageCopy.autoResumeTitle}</Text>
              <Text style={settingsStyles.rowHint}>{providerUsageCopy.autoResumeHint}</Text>
              {autoResumeMutation.error ? (
                <Text style={settingsStyles.rowError}>
                  {autoResumeMutation.error instanceof Error
                    ? autoResumeMutation.error.message
                    : String(autoResumeMutation.error)}
                </Text>
              ) : null}
            </View>
            <Switch
              value={autoResumeEnabled}
              onValueChange={handleAutoResumeToggle}
              disabled={autoResumeMutation.isPending}
              accessibilityLabel={providerUsageCopy.autoResumeTitle}
            />
          </View>
        </View>
      ) : null}
      <ProviderUsageBody view={view} onRefresh={onRefresh} />
    </SettingsSection>
  );
}

function ProviderUsageBody({
  view,
  onRefresh,
}: {
  view: ProviderUsageView;
  onRefresh: () => void;
}) {
  if (view.kind === "loading") {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{providerUsageCopy.loading}</Text>
      </View>
    );
  }

  if (view.kind === "error") {
    return (
      <Alert variant="error" title={providerUsageCopy.errorTitle} description={view.message}>
        <Button variant="outline" size="sm" onPress={onRefresh}>
          {providerUsageCopy.retry}
        </Button>
      </Alert>
    );
  }

  if (view.payload.providers.length === 0) {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{providerUsageCopy.empty}</Text>
      </View>
    );
  }

  return <ProviderUsageList providers={view.payload.providers} />;
}

const styles = StyleSheet.create((theme) => ({
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
