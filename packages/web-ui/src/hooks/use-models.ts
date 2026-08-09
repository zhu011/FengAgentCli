/**
 * @fengagent/web-ui — use-models hook
 *
 * 获取可用模型列表。
 */

import { useEffect, useState } from "react";
import type { ApiClient } from "../api/client.ts";
import type { ModelInfo } from "../api/types.ts";

export interface UseModelsResult {
  models: ModelInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModels(client: ApiClient): UseModelsResult {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getModels()
      .then((res) => {
        if (!cancelled) {
          setModels(res.models);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load models");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, refreshKey]);

  return {
    models,
    loading,
    error,
    refresh: () => setRefreshKey((k) => k + 1),
  };
}
