import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PriceAlert, AlertHistoryItem } from "../types";
import { useAuth } from "./AuthContext";
import { apiJson } from "../utils/apiFetch";
import { playAlertChime } from "../utils/domSound";
import { normalizeLanguage } from "../locales";
interface AlertsContextType {
  alerts: PriceAlert[];
  history: AlertHistoryItem[];
  loading: boolean;
  loadingHistory: boolean;
  notificationPermission: NotificationPermission;
  requestNotificationPermission: () => Promise<NotificationPermission>;
  addAlert: (
    data: Omit<PriceAlert, "id" | "createdAt" | "triggered" | "isActive"> & {
      isActive?: boolean;
    },
  ) => Promise<PriceAlert>;
  addAlertsBatch: (
    items: Array<
      Omit<PriceAlert, "id" | "createdAt" | "triggered" | "isActive"> & {
        isActive?: boolean;
      }
    >,
  ) => Promise<PriceAlert[]>;
  deleteAlert: (id: string) => Promise<boolean>;
  toggleAlert: (id: string) => Promise<void>;
  clearTriggered: () => Promise<number>;
  fetchHistory: () => Promise<void>;
  clearHistory: () => Promise<number>;
  deleteHistoryItem: (id: string) => Promise<boolean>;
  reactivateAlert: (item: AlertHistoryItem | PriceAlert) => Promise<PriceAlert>;
  activeAlertsCount: number;
  triggeredAlertsCount: number;
  historyCount: number;
}
const AlertsContext = createContext<AlertsContextType | undefined>(undefined);
export const AlertsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<PriceAlert[]>([]),
    [history, setHistory] = useState<AlertHistoryItem[]>([]),
    [loading, setLoading] = useState(false),
    [loadingHistory, setLoadingHistory] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof Notification !== "undefined" ? Notification.permission : "default",
  );
  const owner = useRef(user?.uid);
  owner.current = user?.uid;
  const previousAlerts = useRef<PriceAlert[]>([]),
    notified = useRef(new Set<string>()),
    inFlight = useRef(false);
  const request = async (url: string, options: RequestInit = {}) => {
    if (!user) throw new Error("Увійдіть у свій акаунт");
    return apiJson(url, {
      ...options,
      headers: { "Content-Type": "application/json" },
    });
  };
  const refresh = async () => {
    const id = owner.current;
    if (!id || inFlight.current) return;
    inFlight.current = true;
    try {
      const d = await request("/api/alerts?userId=" + encodeURIComponent(id));
      if (owner.current !== id) return;
      const next: PriceAlert[] = d.alerts ?? [];
      let triggered = false;
      for (const alert of next) {
        const previous = previousAlerts.current.find(
            (item) => item.id === alert.id,
          ),
          key = alert.id + ":" + alert.triggeredAt;
        if (
          previous &&
          !previous.triggered &&
          alert.triggered &&
          !notified.current.has(key)
        ) {
          notified.current.add(key);
          triggered = true;
          playAlertChime();
          window.dispatchEvent(
            new CustomEvent("signalhook:alert-triggered", {
              detail: {
                symbol: alert.symbol,
                targetPrice: alert.targetPrice,
                condition: alert.condition,
                triggeredPrice: alert.triggeredPrice,
                message:
                  alert.note ||
                  alert.formationName ||
                  "Цільову ціну досягнуто!",
              },
            }),
          );
          if (
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          )
            try {
              new Notification("h00k: " + alert.symbol, {
                body: `Ціна: ${alert.triggeredPrice} · Ціль: ${alert.targetPrice}\n${alert.note || alert.formationName || ""}`,
                icon: "/favicon.ico",
              });
            } catch {}
        }
      }
      previousAlerts.current = next;
      setAlerts(next);
      if (triggered) void fetchHistory().catch(() => {});
    } finally {
      inFlight.current = false;
    }
  };
  const fetchHistory = async () => {
    const id = owner.current;
    if (!id) return;
    setLoadingHistory(true);
    try {
      const d = await request(
        "/api/alerts/history?userId=" + encodeURIComponent(id),
      );
      if (owner.current === id) setHistory(d.history ?? []);
    } finally {
      if (owner.current === id) setLoadingHistory(false);
    }
  };
  useEffect(() => {
    setAlerts([]);
    setHistory([]);
    previousAlerts.current = [];
    notified.current.clear();
    if (!user) {
      setLoading(false);
      setLoadingHistory(false);
      return;
    }
    let active = true;
    setLoading(true);
    void fetchHistory().catch(() => {});
    void refresh()
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void refresh().catch(() => {});
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [user?.uid]);
  const addAlert: AlertsContextType["addAlert"] = async (data) => {
    const d = await request("/api/alerts", {
      method: "POST",
      body: JSON.stringify({
        ...data,
        userId: user?.uid,
        language: normalizeLanguage(
          localStorage.getItem("crypto_screener_language"),
        ),
      }),
    });
    await refresh();
    return d.alert;
  };
  const addAlertsBatch: AlertsContextType["addAlertsBatch"] = async (
    alerts,
  ) => {
    const d = await request("/api/alerts/batch", {
      method: "POST",
      body: JSON.stringify({
        alerts,
        userId: user?.uid,
        language: normalizeLanguage(
          localStorage.getItem("crypto_screener_language"),
        ),
      }),
    });
    await refresh();
    return d.alerts;
  };
  const deleteAlert = async (id: string) => {
    const d = await request("/api/alerts/" + encodeURIComponent(id), {
      method: "DELETE",
    });
    await refresh();
    return !!d.success;
  };
  const toggleAlert = async (id: string) => {
    await request("/api/alerts/" + encodeURIComponent(id) + "/toggle", {
      method: "POST",
    });
    await refresh();
  };
  const clearTriggered = async () => {
    const d = await request("/api/alerts/clear-triggered", { method: "POST" });
    await refresh();
    return d.count ?? 0;
  };
  const clearHistory = async () => {
    const d = await request("/api/alerts/history/clear", { method: "POST" });
    setHistory([]);
    return d.cleared ?? 0;
  };
  const deleteHistoryItem = async (id: string) => {
    await request("/api/alerts/history/" + encodeURIComponent(id), {
      method: "DELETE",
    });
    setHistory((h) => h.filter((v) => v.id !== id));
    return true;
  };
  const reactivateAlert: AlertsContextType["reactivateAlert"] = async (
    item,
  ) => {
    const existing = alerts.find(
      (alert) => alert.id === ("alertId" in item ? item.alertId : item.id),
    );
    if (existing) {
      const d = await request(
        "/api/alerts/" + encodeURIComponent(existing.id) + "/toggle",
        { method: "POST", body: JSON.stringify({ isActive: true }) },
      );
      await refresh();
      return d.alert;
    }
    return addAlert({
      symbol: item.symbol,
      exchange: item.exchange,
      marketType: item.marketType,
      targetPrice: item.targetPrice,
      condition: item.condition,
      formationName: item.formationName,
      levelType: item.levelType,
      note: item.note,
      isActive: true,
    });
  };
  return (
    <AlertsContext.Provider
      value={{
        alerts,
        history,
        loading,
        loadingHistory,
        notificationPermission: permission,
        requestNotificationPermission: async () => {
          const p =
            typeof Notification !== "undefined"
              ? await Notification.requestPermission()
              : "denied";
          setPermission(p);
          return p;
        },
        addAlert,
        addAlertsBatch,
        deleteAlert,
        toggleAlert,
        clearTriggered,
        fetchHistory,
        clearHistory,
        deleteHistoryItem,
        reactivateAlert,
        activeAlertsCount: alerts.filter((a) => a.isActive && !a.triggered)
          .length,
        triggeredAlertsCount: alerts.filter((a) => a.triggered).length,
        historyCount: history.length,
      }}
    >
      {children}
    </AlertsContext.Provider>
  );
};
export function useAlerts() {
  const value = useContext(AlertsContext);
  if (!value) throw new Error("useAlerts потребує AlertsProvider");
  return value;
}
